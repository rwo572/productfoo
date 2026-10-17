import type { PacketContext } from "../../src/cli.js";
import { validatePacket } from "../../src/packetValidation.js";

export function validatePacketCommand(context: PacketContext): string {
  return validatePacket({
    packetDir: context.packetDir,
    label: "calpal-scheduling",
  });
}

export { validatePacketCommand as validatePacket };
