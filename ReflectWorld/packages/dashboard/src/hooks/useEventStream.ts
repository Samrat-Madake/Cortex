import { useMemo } from "react";
import type { MonitorEvent, MonitorEventType } from "../types";

export function useEventsByType(events: MonitorEvent[], ...types: MonitorEventType[]): MonitorEvent[] {
  return useMemo(
    () => events.filter((e) => types.includes(e.type as MonitorEventType)),
    [events, ...types],
  );
}

export function useEventsByPrefix(events: MonitorEvent[], prefix: string): MonitorEvent[] {
  return useMemo(
    () => events.filter((e) => e.type.startsWith(prefix)),
    [events, prefix],
  );
}
