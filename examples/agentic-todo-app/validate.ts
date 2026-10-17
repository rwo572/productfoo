import type { PacketContext } from "../../src/cli.js";
import { validatePacket } from "../../src/packetValidation.js";

export function validatePacketCommand(context: PacketContext): string {
  return validatePacket({
    packetDir: context.packetDir,
    label: "agentic-todo-app",
    requireSpecSections: true,
    requiredSpecRef: "examples/agentic-todo-app/spec.md",
  });
}

export { validatePacketCommand as validatePacket };
