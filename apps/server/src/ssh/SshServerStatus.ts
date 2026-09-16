/**
 * 远程服务器状态采样：一条带标记的复合 shell 命令 + 纯函数解析。
 *
 * Linux 优先（/proc、free、df）；字段缺失时静默降级（macOS/BSD 只报 os 与在线）。
 * CPU 占用来自 /proc/stat 的双采样差值，采样间隔 0.5s，所以整条命令约需 1 秒。
 *
 * @module SshServerStatus
 */

const MARKER_PREFIX = "##CODEWORK-";

export const SSH_STATUS_COMMAND = [
  `echo ${MARKER_PREFIX}UNAME`,
  "uname -a",
  `echo ${MARKER_PREFIX}UPTIME`,
  "cat /proc/uptime 2>/dev/null",
  `echo ${MARKER_PREFIX}LOAD`,
  "cat /proc/loadavg 2>/dev/null",
  `echo ${MARKER_PREFIX}MEM`,
  "free -b 2>/dev/null",
  `echo ${MARKER_PREFIX}DISK`,
  "df -B1 / 2>/dev/null",
  `echo ${MARKER_PREFIX}CPU1`,
  "grep '^cpu ' /proc/stat 2>/dev/null",
  "sleep 0.5",
  `echo ${MARKER_PREFIX}CPU2`,
  "grep '^cpu ' /proc/stat 2>/dev/null",
  `echo ${MARKER_PREFIX}END`,
].join("; ");

interface SshStatusSample {
  readonly os?: string | undefined;
  readonly uptimeSeconds?: number | undefined;
  readonly loadAvg?: ReadonlyArray<number> | undefined;
  readonly cpuPercent?: number | undefined;
  readonly memoryUsedMb?: number | undefined;
  readonly memoryTotalMb?: number | undefined;
  readonly diskUsedGb?: number | undefined;
  readonly diskTotalGb?: number | undefined;
}

const splitMarkerSections = (output: string): Map<string, string> => {
  const sections = new Map<string, string>();
  let current: string | null = null;
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    const marker = line.startsWith(MARKER_PREFIX) ? line.slice(MARKER_PREFIX.length).trim() : null;
    if (marker !== null) {
      if (current !== null) sections.set(current, lines.join("\n"));
      current = marker;
      lines.length = 0;
      continue;
    }
    if (current !== null) lines.push(line);
  }
  if (current !== null) sections.set(current, lines.join("\n"));
  return sections;
};

const firstNonEmptyLine = (text: string | undefined): string | null => {
  if (text === undefined) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
};

const parseUptime = (text: string | undefined): number | undefined => {
  const line = firstNonEmptyLine(text);
  if (line === null) return undefined;
  const seconds = Number.parseFloat(line.split(/\s+/)[0] ?? "");
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : undefined;
};

const parseLoadAvg = (text: string | undefined): ReadonlyArray<number> | undefined => {
  const line = firstNonEmptyLine(text);
  if (line === null) return undefined;
  const values = line
    .split(/\s+/)
    .slice(0, 3)
    .flatMap((token) => {
      const value = Number.parseFloat(token);
      return Number.isFinite(value) ? [value] : [];
    });
  return values.length > 0 ? values : undefined;
};

/** `free -b` 的 Mem 行：total used free …（仅取 total 与 available 近似的 used）。 */
const parseMemory = (text: string | undefined): { usedMb: number; totalMb: number } | undefined => {
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    if (!/^\s*Mem:/.test(line)) continue;
    const columns = line.trim().split(/\s+/).slice(1).map(Number);
    if (columns.length < 2 || columns.slice(0, 2).some((value) => !Number.isFinite(value))) {
      return undefined;
    }
    const total = columns[0];
    const used = columns[1];
    if (total === undefined || used === undefined) return undefined;
    return {
      totalMb: Math.round(total / (1024 * 1024)),
      usedMb: Math.round(used / (1024 * 1024)),
    };
  }
  return undefined;
};

/** `df -B1 /` 的数据行：filesystem total used available use% mount。 */
const parseDisk = (text: string | undefined): { usedGb: number; totalGb: number } | undefined => {
  // 设备名列可能是任意字符串（长名还会换行），所以把数据行拼成一条 token
  // 流后从首个数值 token 开始取：total used available 依次排列。
  const tokens = (text ?? "")
    .split("\n")
    .filter((entry) => entry.length > 0 && !/^\s*Filesystem/.test(entry))
    .join(" ")
    .trim()
    .split(/\s+/)
    .map(Number);
  const startIndex = tokens.findIndex((value) => Number.isFinite(value));
  if (startIndex < 0 || tokens.length - startIndex < 3) return undefined;
  const total = tokens[startIndex];
  const used = tokens[startIndex + 1];
  if (total === undefined || used === undefined) return undefined;
  const roundGb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
  return { usedGb: roundGb(used), totalGb: roundGb(total) };
};

const parseCpuTimes = (text: string | undefined): ReadonlyArray<number> | undefined => {
  const line = firstNonEmptyLine(text);
  if (line === null) return undefined;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  return values.length >= 4 && values.every((value) => Number.isFinite(value)) ? values : undefined;
};

const cpuPercentFromSamples = (
  first: ReadonlyArray<number> | undefined,
  second: ReadonlyArray<number> | undefined,
): number | undefined => {
  if (first === undefined || second === undefined || first.length !== second.length) {
    return undefined;
  }
  let totalDelta = 0;
  let idleDelta = 0;
  for (let index = 0; index < first.length; index += 1) {
    const delta = (second[index] ?? 0) - (first[index] ?? 0);
    if (delta < 0) return undefined;
    totalDelta += delta;
    // idle = idle + iowait（第 4、5 列）
    if (index === 3 || index === 4) idleDelta += delta;
  }
  if (totalDelta <= 0) return undefined;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
};

export function parseSshStatusOutput(output: string): SshStatusSample {
  const sections = splitMarkerSections(output);
  const memory = parseMemory(sections.get("MEM"));
  const disk = parseDisk(sections.get("DISK"));
  const cpuFirst = parseCpuTimes(sections.get("CPU1"));
  const cpuSecond = parseCpuTimes(sections.get("CPU2"));
  return {
    os: firstNonEmptyLine(sections.get("UNAME")) ?? undefined,
    uptimeSeconds: parseUptime(sections.get("UPTIME")),
    loadAvg: parseLoadAvg(sections.get("LOAD")),
    cpuPercent: cpuPercentFromSamples(cpuFirst, cpuSecond),
    memoryUsedMb: memory?.usedMb,
    memoryTotalMb: memory?.totalMb,
    diskUsedGb: disk?.usedGb,
    diskTotalGb: disk?.totalGb,
  };
}
