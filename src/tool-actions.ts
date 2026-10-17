import type {Actor, JsonObject} from './types.js';

/**
 * Composite tool actions as tables (ARC-04 stage D). A composite tool declares each action as an entry of a table instead
 * of a branch of an if-chain over `action`, so a new action is one entry and the checks between groups of actions stay
 * where the dispatcher states them. amcp_reporting is the first (src/decision-reporting.ts). A leaf: it imports no tool,
 * lifecycle or provider module.
 */

/** One call of a composite tool's action: its arguments and the caller. A tool extends it with what its actions share. */
export interface ToolContext {
  readonly input: JsonObject;
  readonly actor: Actor;
}
/** One action of a composite tool. */
export type ToolAction<C extends ToolContext> = (context: C) => Promise<JsonObject> | JsonObject;
/** A composite tool's actions by name. */
export type ActionTable<C extends ToolContext> = Readonly<Record<string, ToolAction<C>>>;

/** The entry of `table` for `action`: an own entry only, so an inherited name (`constructor`, `toString`) is no action. */
export function actionHandler<C extends ToolContext>(
  table: ActionTable<C>,
  action: unknown,
): ToolAction<C> | undefined {
  return typeof action === 'string' && Object.hasOwn(table, action) ? table[action] : undefined;
}
