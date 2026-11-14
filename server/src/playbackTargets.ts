import { hostdata } from "./hostConfig.js"
import type { Device } from "./types.js"

/** ADB serials are explicit deployment settings, never inferred from arbitrary clients. */
export function isAdbTarget(
  value: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*:[0-9]{1,5}$/.test(value)
  )
    return false
  const port = Number(value.split(":")[1])
  return port > 0 && port <= 65535
}

export function parsePlaybackTargets(
  value: unknown,
): Device[] {
  if (value == null) return []
  if (!Array.isArray(value))
    throw new Error("playback_targets must be an array")
  const ids = new Set(["shield"])
  const machines = new Set<string>()
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object")
      throw new Error("invalid playback target")
    const target = row as Record<string, unknown>
    if (
      typeof target.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(target.id) ||
      ids.has(target.id)
    )
      throw new Error(
        "invalid or duplicate playback target id",
      )
    if (
      typeof target.name !== "string" ||
      !target.name.trim()
    )
      throw new Error(
        `playback target ${target.id} needs a name`,
      )
    if (typeof target.uri !== "string")
      throw new Error(
        `playback target ${target.id} needs a uri`,
      )
    const uri = new URL(target.uri)
    if (
      !["http:", "https:"].includes(uri.protocol) ||
      uri.username ||
      uri.password ||
      uri.pathname !== "/" ||
      uri.search ||
      uri.hash
    )
      throw new Error(
        `invalid playback target uri for ${target.id}`,
      )
    if (
      target.adb_target != null &&
      !isAdbTarget(target.adb_target)
    )
      throw new Error(`invalid adb_target for ${target.id}`)
    if (
      target.adb_target &&
      String(target.adb_target).split(":")[0] !==
        uri.hostname
    )
      throw new Error(
        `adb_target and uri must name the same player for ${target.id}`,
      )
    const machine =
      typeof target.machine_identifier === "string"
        ? target.machine_identifier
        : ""
    if (machine && machines.has(machine))
      throw new Error(
        "duplicate playback target machine identifier",
      )
    ids.add(target.id)
    if (machine) machines.add(machine)
    return {
      id: target.id,
      name: target.name,
      uri: uri.origin,
      machineIdentifier: machine,
      mode: "client",
      default: false,
      ...(target.adb_target
        ? { adbTarget: String(target.adb_target) }
        : {}),
    }
  })
}

export const configuredPlaybackTargets = (): Device[] =>
  parsePlaybackTargets(hostdata("playback_targets"))
