export function parseShowinfoPtsMs(stderr: string): number[] {
  const pts: number[] = [];
  const re = /pts_time:\s*(-?[\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const seconds = Number.parseFloat(match[1]!);
    if (Number.isFinite(seconds)) pts.push(seconds * 1000);
  }
  return pts;
}

export function parseCompleteShowinfoLines(buffer: string): { ptsMs: number[]; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";
  return { ptsMs: parseShowinfoPtsMs(lines.join("\n")), remaining };
}
