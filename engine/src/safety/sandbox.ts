export interface SandboxProfile {
  name: string;
  network: "enabled" | "disabled" | "restricted";
  filesystem: "read-only" | "workspace-write" | "full";
  commandAllowList?: string[];
}
