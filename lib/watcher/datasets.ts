/**
 * Registers every vertical watcher dataset. New views import from here so a
 * single import wires the registry. Add a vertical: author its dataset file,
 * register it below.
 */

import { registerWatcherDataset } from "./index";
import { LEDGERLINE_WATCHER } from "./ledgerline-watcher";
import { SECOND_NATURE_WATCHER } from "./second-nature-watcher";

registerWatcherDataset("second-nature", () => SECOND_NATURE_WATCHER);
registerWatcherDataset("ledgerline", () => LEDGERLINE_WATCHER);

export { getWatcherDataset, totals, bucketCounts } from "./index";
export type * from "./types";
