// Stand-in for server/src/store/db/gatedPush.js under the driver's unit tests.
//
// The real module opens the book of record, and the FSM suites are offline unit tests with no
// database: letting them reach SQLite would migrate a file as a side effect of asserting on a
// profile gate. The rows land in CTL.gatedPushes so a scenario can assert that a push WAS
// logged — which matters on the no-opinion path, the one the attribution audit exists for.
import { CTL } from './control.mjs';

export function recordPush(input) {
  CTL.gatedPushes.push(input);
  return CTL.gatedPushes.length;
}

export function pushesSince() { return []; }

export function prunePushesBefore() { return 0; }
