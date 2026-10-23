// Copies the non-TypeScript files the compiled code reads at runtime into dist/,
// so dist/ is self-contained (the Docker image ships only dist/ and node_modules/).
import { cpSync, existsSync } from "node:fs";

for (const dir of ["migrations", "agent/documents"]) {
    if (existsSync(dir)) {
        cpSync(dir, `dist/${dir}`, { recursive: true });
    }
}
