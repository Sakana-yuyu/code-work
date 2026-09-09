export async function revealTerminalPanel(
  isVisible: boolean,
  show: () => Promise<void>,
): Promise<boolean> {
  if (isVisible) return false;
  await show();
  return true;
}
