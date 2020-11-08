// MineBuffer.ts - a binary buffer supporting Minecraft protocol types
// Copyright (C) 2020 MineNode
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import * as Long from "long";
import * as uuid from "uuid";

import BasicPosition3D from "./geometry/BasicPosition3D";
import { IBasicPosition3D } from "./geometry/BasicPosition3D";
import { Chat, isChat } from "./Chat";

/**
 * A wrapper around a Buffer offering dynamic size and support for Minecraft protocol types.
 */
export default class MineBuffer {
  public buffer: Buffer;
  public writeOffset = 0;
  public readOffset = 0;

  public constructor(buffer?: Buffer) {
    if (typeof buffer === "undefined") {
      this.buffer = Buffer.alloc(0);
    } else {
      this.buffer = Buffer.from(buffer);
      this.writeOffset = buffer.length;
    }
  }

  /**
   * Ensure at least `size` bytes are available for writing.
   */
  public reserve(size: number): void {
    if (this.buffer.length - this.writeOffset < size) {
      const padding = Math.max(size, this.buffer.length);
      this.buffer = Buffer.concat([this.buffer, Buffer.alloc(padding)]);
    }
  }

  /**
   * Returns the managed portion `(0 ... writeOffset)` of the buffer.
   */
  public getBuffer(): Buffer {
    return this.buffer.slice(0, this.writeOffset);
  }

  /**
   * The number of bytes remaining that can be read.
   */
  public get remaining(): number {
    return this.writeOffset - this.readOffset;
  }

  /**
   * Creates a new, independent MineBuffer instance with the same state as this one.
   */
  public clone(): MineBuffer {
    const cloned = new MineBuffer(this.buffer);
    cloned.writeOffset = this.writeOffset;
    cloned.readOffset = this.readOffset;
    return cloned;
  }

  /**
   * Resets this buffer to a zeroed state.
   */
  public reset(): this {
    this.buffer = Buffer.alloc(0);
    this.readOffset = 0;
    this.writeOffset = 0;
    return this;
  }

  /**
   * Peeks at the byte ahead, returning its value without moving ahead in the buffer
   */
  public peekByte(): number {
    if (this.remaining < 1) throw new RangeError("peekByte() out-of-bounds");
    return this.buffer.slice(this.readOffset, this.readOffset + 1).readInt8();
  }

  /**
   * Advances the read offset
   *
   * @param n the number of bytes to advance
   */
  public advanceReadOffset(n: number): void {
    if (n < 1) return;
    this.readOffset += n;
  }

  /**
   * Reads multiple bytes from the buffer.
   * @param n the number of bytes to read (positive integer)
   * @throws {RangeError} if the buffer is exhausted.
   */
  public readBytes(n: number): Buffer {
    if (n < 0 || ~~n !== n) throw new RangeError("n must be a positive integer");
    if (this.remaining < n) throw new RangeError("readBytes() out-of-bounds");
    return this.buffer.slice(this.readOffset, (this.readOffset += n));
  }

  /**
   * Reads remaining bytes from the buffer.
   */
  public readRemaining(): Buffer {
    return this.readBytes(this.remaining);
  }

  /**
   * Reads a byte (signed) from the buffer.
   * @throws {RangeError} if the buffer is exhausted.
   */
  public readByte(): number {
    return this.readBytes(1).readInt8();
  }

  /**
   * Reads an unsigned 8-bit integer from the buffer.
   */
  public readUByte(): number {
    return this.readByte() & 0xff;
  }

  /**
   * Reads a boolean (0x00 or 0x01) from the buffer.
   * @throws {TypeError} if the value read is not 0x00 or 0x01.
   */
  public readBoolean(): boolean {
    const value = this.readByte();
    if (value === 0x00) return false;
    else if (value === 0x01) return true;
    else throw new TypeError("invalid value for encoded boolean");
  }

  /**
   * Read a signed 32-bit integer, two's complement.
   */
  public readInt(): number {
    return this.readBytes(4).readInt32BE();
  }

  /**
   * Read a signed 64-bit integer, two's complement.
   */
  public readLong(): Long {
    const bytes = this.readBytes(8);
    return Long.fromBytesBE(Array.from(bytes), false);
  }

  /**
   * Read a single-precision 32-bit IEEE 754 floating point number.
   */
  public readFloat(): number {
    return this.readBytes(4).readFloatBE();
  }

  /**
   * Read a double-precision 64-bit IEEE 754 floating point number.
   */
  public readDouble(): number {
    return this.readBytes(8).readDoubleBE();
  }

  /**
   * Reads a variable-length integer (VarInt).
   * @throws {Error} if the VarInt is too large
   */
  public readVarInt(): number {
    let numRead = 0,
      result = 0;
    let read;
    do {
      read = this.readByte();
      const value = read & 0b01111111;
      result |= value << (7 * numRead);
      numRead++;
      if (numRead > 5) throw new Error("VarInt is too big");
    } while ((read & 0b10000000) != 0);
    return result;
  }

  /**
   * Reads a variable-length long integer (VarLong).
   * Returns a Long (long.js) object.
   * @throws {Error} if the VarLong is too large.
   */
  public readVarLong(): Long {
    let numRead = 0,
      result = Long.ZERO;
    let read;
    do {
      read = this.readByte();
      const value = new Long(read & 0b01111111);
      result = result.or(value.shiftLeft(7 * numRead));
      numRead++;
      if (numRead > 10) throw new Error("VarLong is too big");
    } while ((read & 0b10000000) != 0);
    return result;
  }

  /**
   * Reads a string VarInt length prefixed UTF-8 encoded string from the buffer.
   * @throws {Error} if the read length prefix is invalid
   */
  public readString(): string {
    const len = this.readVarInt();
    if (len < 0 || len > 32767) throw new Error("Invalid length-prefix for string value");
    const bytes = this.readBytes(len);
    return bytes.toString("utf-8");
  }

  /**
   * Reads a Chat from the buffer.
   * @throws {Error} if the JSON is invalid
   * @throws {TypeError} is the read chat is invalid
   */
  public readChat(): Chat {
    const str = this.readString();
    const decoded = JSON.parse(str);
    if (isChat(decoded)) {
      return decoded;
    } else {
      throw new TypeError("Invalid Chat");
    }
  }

  /**
   * Reads a signed 16 bit integer.
   */
  public readShort(): number {
    return this.readBytes(2).readInt16BE();
  }

  /**
   * Reads an unsigned 16 bit integer.
   */
  public readUShort(): number {
    return this.readBytes(2).readUInt16BE();
  }

  /**
   * Reads an integer X/Y/Z position from 8 bytes.
   */
  public readPosition(): BasicPosition3D {
    const val = Long.fromBytesBE(Array.from(this.readBytes(8)), true);
    let x = val.shiftRight(38).toSigned();
    let y = val.and(0xfff).toSigned();
    let z = val.shiftLeft(26).shiftRight(38).toSigned();

    if (x.greaterThanOrEqual(2 ** 25)) x = x.sub(2 ** 26);
    if (y.greaterThanOrEqual(2 ** 11)) y = y.sub(2 ** 12);
    if (z.greaterThanOrEqual(2 ** 25)) z = z.sub(2 ** 26);

    return new BasicPosition3D(x.toInt(), y.toInt(), z.toInt());
  }

  /**
   * Reads a UUID in string form.
   */
  public readUUID(): string {
    const bytes = this.readBytes(16);
    return uuid.stringify(bytes);
  }

  /**
   * Appends many bytes to the buffer.
   * @param bytes the bytes to append
   */
  public writeBytes(bytes: Buffer): this {
    this.reserve(bytes.length);
    bytes.copy(this.buffer, this.writeOffset);
    this.writeOffset += bytes.length;
    return this;
  }

  /**
   * Appends a byte (signed) to the buffer.
   * @param byte the byte to append
   */
  public writeByte(byte: number): this {
    this.reserve(1);
    this.buffer.writeInt8(byte, this.writeOffset);
    this.writeOffset += 1;
    return this;
  }

  /**
   * Appends a boolean to the buffer (0x00 = false, 0x01 = true).
   * @param value the boolean to encode
   */
  public writeBoolean(value: boolean): this {
    this.writeByte(value ? 1 : 0);
    return this;
  }

  /**
   * Writes a float to the buffer.
   * @param value the value to write
   */
  public writeFloat(value: number): this {
    this.reserve(4);
    this.buffer.writeFloatBE(value, this.writeOffset);
    this.writeOffset += 4;
    return this;
  }

  /**
   * Writes a double to the buffer.
   * @param value the value to write
   */
  public writeDouble(value: number): this {
    this.reserve(8);
    this.buffer.writeDoubleBE(value, this.writeOffset);
    this.writeOffset += 8;
    return this;
  }

  /**
   * Writes a 32-bit signed integer to the buffer.
   * @param value the value to write
   */
  public writeInt(value: number): this {
    this.reserve(4);
    this.buffer.writeInt32BE(value, this.writeOffset);
    this.writeOffset += 4;
    return this;
  }

  /**
   * Writes a 64-bit signed integer to the buffer.
   * @param value the value to write
   */
  public writeLong(value: Long): this {
    this.writeBytes(Buffer.from(value.toSigned().toBytesBE()));
    return this;
  }

  /**
   * Encodes an integer X/Y/Z position to a 64-bit value.
   * @param pos the position to encode
   */
  public writePosition(pos: IBasicPosition3D): this {
    const val = Long.fromInt(pos.x & 0x3ffffff, true)
      .shiftLeft(38)
      .or(Long.fromInt(pos.z & 0x3ffffff, true).shiftLeft(12))
      .or(Long.fromInt(pos.y & 0xfff, true));
    const bytes = Buffer.from(val.toBytesBE());
    this.writeBytes(bytes);
    return this;
  }

  /**
   * Encodes a UUID to a 128-bit value.
   * @param value the UUID to write, in string format
   * @throws {TypeError} if the UUID is invalid
   */
  public writeUUID(value: string): this {
    if (!uuid.validate(value)) throw new TypeError("invalid uuid to encode");
    this.writeBytes(Buffer.from(uuid.parse(value)));
    return this;
  }

  /**
   * Writes a 16-bit signed integer to the buffer.
   * @param value the value to write
   */
  public writeShort(value: number): this {
    this.reserve(2);
    this.buffer.writeInt16BE(value, this.writeOffset);
    this.writeOffset += 2;
    return this;
  }

  /**
   * Writes a variable-length integer (VarInt) to the buffer.
   * @param value the number to encode
   * @throws {TypeError} if the value passed is not an integer
   */
  public writeVarInt(value: number): this {
    if (value !== ~~value) throw new TypeError("value must be an integer");
    do {
      let temp = value & 0b01111111;
      value >>>= 7;
      if (value != 0) temp |= 0b10000000;
      this.writeByte((temp << 24) >> 24);
    } while (value != 0);
    return this;
  }

  /**
   * Writes a variable-length Long (VarLong) to the buffer.
   * @param value the value to write
   */
  public writeVarLong(value: Long): this {
    do {
      let temp = value.and(0b01111111);
      value = value.shiftRightUnsigned(7);
      if (value.notEquals(0)) temp = temp.or(0b10000000);
      this.writeByte((temp.toInt() << 24) >> 24);
    } while (value.notEquals(0));
    return this;
  }

  /**
   * Writes a VarInt length-prefixed UTF-8 encoded string to the buffer.
   * @param value the string to encode
   * @throws {Error} if the string exceeds the maximum byte length when encoded as UTF-8.
   */
  public writeString(value: string): this {
    const bytes = Buffer.from(value, "utf-8");
    if (bytes.length > 32767 * 4) throw new Error("encoded string exceeds max length");
    this.writeVarInt(bytes.length);
    this.writeBytes(bytes);
    return this;
  }

  /**
   * Writes a Chat value (JSON-encoded) to the buffer.
   * @param value the Chat to encode
   */
  public writeChat(value: Chat): this {
    this.writeString(JSON.stringify(value));
    return this;
  }

  /**
   * Wries an unsigned 8-bit integer (byte) to the buffer.
   * @param value the value to write
   */
  public writeUByte(value: number): this {
    this.writeByte((value << 24) >> 24); // Converts u8 -> i8
    return this;
  }

  /**
   * Writes an unsigned 16-bit integer to the buffer (big-endian).
   * @param value the value to write
   */
  public writeUShort(value: number): this {
    this.reserve(2);
    this.buffer.writeUInt16BE(value, this.writeOffset);
    this.writeOffset += 2;
    return this;
  }
}
