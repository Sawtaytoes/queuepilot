// `defined()` lives in `shared/` so the web app checks a value the same way. The server and
// the e2e harnesses keep importing it from here.
export { defined } from "../../shared/defined.js"
