import { FixtureRegistry } from "../fixture-registry.js";
import { JourneyError, type JourneyContext, type TargetSession } from "./types.js";

/** One registry per campaign: an onboarding receipt may satisfy later prerequisites. */
export function journeyFixtures(session: TargetSession) {
  let ready: JourneyContext | undefined;
  const registry = new FixtureRegistry().register({
    id: "ready-context",
    async setup() { return ready ??= await session.prepare(); },
  });
  for (const id of ["company", "board-user", "task-write"]) registry.register({
    id, dependencies: ["ready-context"],
    async setup(resolved) {
      const context = resolved.get("ready-context") as JourneyContext;
      if (!context.capabilities.includes(id)) throw new JourneyError("unsupported", `missing_${id}`);
      return context;
    },
  });
  return {
    provide(context: JourneyContext) { ready = context; },
    async resolve(required: readonly string[]) {
      const fixtures = await registry.setupAll(required);
      return fixtures.values.get("ready-context") as JourneyContext;
    },
  };
}
