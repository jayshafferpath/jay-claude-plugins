import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Scoped to the dashboard's own pure logic. The heavy lifting lives in cli/lib,
// which has its own suite and 90% gate; this covers the parts that only exist
// here — UI selectors and the job runner's bookkeeping.
//
// No coverage threshold: most files here are React components whose value is in
// rendering, not in branch logic, and a number that forces tests for JSX markup
// would buy less than it costs.
export default defineConfig({
  // Needed to parse the .jsx modules the selectors live alongside.
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{js,jsx}"],
  },
});
