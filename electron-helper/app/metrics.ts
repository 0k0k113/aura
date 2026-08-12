// app/metrics.ts
//
// Resource telemetry, so "the app made my whole machine slow" can be answered
// with numbers instead of a guess.
//
// After the fact there is no evidence left: the app has quit, the memory is
// back, and all anyone has is the impression. These counters are ones Chromium
// already maintains, so reading them is cheap and synchronous, and they ride
// along in both the tray's "Copy diagnostics" and the `presence:ping` reply.

import { app } from 'electron'

export interface ProcessMetric {
  type: string
  pid: number
  /** Percentage of ONE core, so values above 100 are possible and normal. */
  cpuPercent: number
  memoryMB: number
}

export interface ResourceMetrics {
  /**
   * How long this app has been running. The number that makes the rest
   * legible: memory that only looks large next to a long uptime is growth
   * rather than a baseline, which is the difference between a leak and a
   * heavy-but-stable app.
   */
  uptimeSeconds: number
  processes: ProcessMetric[]
  totalMemoryMB: number
}

export function collectResourceMetrics(): ResourceMetrics | null {
  try {
    const processes: ProcessMetric[] = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      // workingSetSize is reported in kilobytes.
      memoryMB: Math.round((metric.memory?.workingSetSize ?? 0) / 1024),
    }))

    return {
      uptimeSeconds: Math.round(process.uptime()),
      processes,
      totalMemoryMB: processes.reduce((sum, p) => sum + p.memoryMB, 0),
    }
  } catch {
    // Diagnostics must never be the thing that breaks the app.
    return null
  }
}
