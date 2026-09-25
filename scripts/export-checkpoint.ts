// Read-only: derives an immutable continuation checkpoint from a parent run's durable state.
// With RECOVERY_BOUNDARY_DATE it exports a separately labelled supplemental recovery from that last valid day.
import { exportCheckpoint } from "../src/study/segment.ts";
import { resolve } from "node:path";
const [parentDir, note, boundaryDate] = process.argv.slice(2);
if (!parentDir || !note) throw new Error("usage: export-checkpoint PARENT_RUN_DIR AUTHORIZATION_NOTE [RECOVERY_BOUNDARY_DATE]");
console.log(JSON.stringify(exportCheckpoint(resolve(parentDir), { note, at: new Date().toISOString() }, boundaryDate), null, 2));
