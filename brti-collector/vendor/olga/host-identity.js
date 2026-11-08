import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
/**
 * Identity comes from the operating system. Callers cannot pass it in.
 * Linux reads /etc/machine-id. macOS reads IOPlatformUUID. The home directory
 * comes from the password database, not the HOME environment variable.
 * This Linux process is not Olga, so the tick stops here.
 */
export function readHostIdentity() {
    const home = userInfo().homedir;
    if (process.platform === "linux") {
        return {
            machineId: readFileSync("/etc/machine-id", "utf8").trim().toLowerCase(),
            home,
        };
    }
    if (process.platform === "darwin") {
        const listing = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
        const match = listing.match(/"IOPlatformUUID" = "([^"]+)"/);
        if (!match?.[1]) {
            throw new Error("macOS platform UUID is unavailable.");
        }
        return { machineId: match[1].toLowerCase(), home };
    }
    return { machineId: "unsupported-platform", home };
}
//# sourceMappingURL=host-identity.js.map