/**
 * Builds a minimal WebAssembly module whose only exports are no-op functions
 * with the given names. Test-only: lets identity checks run against synthetic
 * "wrong ABI" binaries without shipping fake artifacts.
 */
function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

export function moduleWithExports(names: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const type = [0x60, 0x00, 0x00]; // func () -> ()
  const body = [0x02, 0x00, 0x0b]; // size 2: no locals, end
  const bytes = [
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, vector([type])),
    ...section(3, vector(names.map(() => [0x00]))),
    ...section(
      7,
      vector(
        names.map((name, index) => {
          const encoded = [...encoder.encode(name)];
          return [...uleb(encoded.length), ...encoded, 0x00, ...uleb(index)];
        })
      )
    ),
    ...section(10, vector(names.map(() => body))),
  ];
  return new Uint8Array(bytes);
}
