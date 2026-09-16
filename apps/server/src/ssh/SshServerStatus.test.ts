import { describe, expect, it } from "vite-plus/test";

import { SSH_STATUS_COMMAND, parseSshStatusOutput } from "./SshServerStatus.ts";

const linuxSample = [
  "##CODEWORK-UNAME",
  "Linux vm 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux",
  "##CODEWORK-UPTIME",
  "987654.32 1954321.00",
  "##CODEWORK-LOAD",
  "0.10 0.20 0.30 1/123 4567",
  "##CODEWORK-MEM",
  "              total        used        free      shared  buff/cache   available",
  "Mem:      16384000000 8192000000 4096000000   102400000 4096000000 7340032000",
  "Swap:      2097152000           0 2097152000",
  "##CODEWORK-DISK",
  "Filesystem      1-blocks       Used Available Use% Mounted on",
  "/dev/vda1     85899345920 42949672960 42949672960  50% /",
  "##CODEWORK-CPU1",
  "cpu  100 0 50 1000 0 0 0 0 0 0",
  "##CODEWORK-CPU2",
  "cpu  150 0 60 1150 10 0 0 0 0 0",
  "##CODEWORK-END",
].join("\n");

describe("parseSshStatusOutput", () => {
  it("parses a complete Linux sample", () => {
    expect(parseSshStatusOutput(linuxSample)).toEqual({
      os: "Linux vm 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux",
      uptimeSeconds: 987654,
      loadAvg: [0.1, 0.2, 0.3],
      // idle+iowait 差值 160 / 总差值 220 → 27.3%
      cpuPercent: 27.3,
      memoryUsedMb: 7813,
      memoryTotalMb: 15625,
      diskUsedGb: 40,
      diskTotalGb: 80,
    });
  });

  it("parses a long device name wrapped onto its own line", () => {
    const sample = [
      "##CODEWORK-DISK",
      "Filesystem      1-blocks       Used Available Use% Mounted on",
      "/dev/mapper/ubuntu--vg-ubuntu--lv",
      "                       85899345920 42949672960 42949672960  50% /",
      "##CODEWORK-END",
    ].join("\n");
    expect(parseSshStatusOutput(sample)).toMatchObject({
      diskUsedGb: 40,
      diskTotalGb: 80,
    });
  });

  it("degrades silently on a non-Linux host (only uname answered)", () => {
    const sample = [
      "##CODEWORK-UNAME",
      "Darwin mac 23.5.0 arm64",
      "##CODEWORK-UPTIME",
      "",
      "##CODEWORK-END",
    ].join("\n");
    expect(parseSshStatusOutput(sample)).toEqual({
      os: "Darwin mac 23.5.0 arm64",
      uptimeSeconds: undefined,
      loadAvg: undefined,
      cpuPercent: undefined,
      memoryUsedMb: undefined,
      memoryTotalMb: undefined,
      diskUsedGb: undefined,
      diskTotalGb: undefined,
    });
  });

  it("returns every field undefined for garbage output instead of throwing", () => {
    expect(parseSshStatusOutput("total garbage\r\nno markers here")).toEqual({
      os: undefined,
      uptimeSeconds: undefined,
      loadAvg: undefined,
      cpuPercent: undefined,
      memoryUsedMb: undefined,
      memoryTotalMb: undefined,
      diskUsedGb: undefined,
      diskTotalGb: undefined,
    });
  });

  it("gives up on CPU percent when the two samples differ in length", () => {
    const sample = [
      "##CODEWORK-CPU1",
      "cpu  100 0 50 1000",
      "##CODEWORK-CPU2",
      "cpu  150 0 60 1150 10 0 0 0 0 0",
      "##CODEWORK-END",
    ].join("\n");
    expect(parseSshStatusOutput(sample).cpuPercent).toBeUndefined();
  });

  it("keeps the sampling markers intact between command and parser", () => {
    for (const marker of ["UNAME", "UPTIME", "LOAD", "MEM", "DISK", "CPU1", "CPU2", "END"]) {
      expect(SSH_STATUS_COMMAND).toContain(`##CODEWORK-${marker}`);
    }
  });
});
