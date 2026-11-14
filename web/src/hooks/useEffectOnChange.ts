import {
  type EffectCallback,
  useEffect,
  useEffectEvent,
} from "react"

/**
 * Runs `effect(trigger)` on mount and after each commit in which `trigger` changed (by
 * `Object.is`), which is exactly when `useEffect(effect, [trigger])` runs.
 *
 * For an effect whose trigger is not a value it reads: a route change that closes a menu, a
 * reload counter, or a search key that reruns the current text. Biome's
 * `useExhaustiveDependencies` reports a dependency that the effect does not read, so the
 * trigger is handed to the effect instead, which is free to ignore it.
 *
 * `effect` is an Effect Event (`useEffectEvent`): it reads the values of the render that ran
 * it, and a new closure on a later render does not run it again. A function it returns is the
 * cleanup, as in `useEffect`.
 */
export function useEffectOnChange<Trigger>(
  trigger: Trigger,
  effect: (trigger: Trigger) => ReturnType<EffectCallback>,
) {
  const runEffect = useEffectEvent(effect)

  useEffect(() => runEffect(trigger), [trigger])
}
