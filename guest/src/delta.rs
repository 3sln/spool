use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};
use vcdiff_common::{TableInst, VCD_C_TABLE};

pub const MEDIA: &str = "application/vnd.spool.workspace.patch.v1+vcdiff";
const WINDOW: u64 = 16 * 1024 * 1024;

fn invalid(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

fn byte(reader: &mut impl Read) -> io::Result<u8> {
    let mut bytes = [0];
    reader.read_exact(&mut bytes)?;
    Ok(bytes[0])
}

fn number(reader: &mut impl Read) -> io::Result<u64> {
    let mut value = 0u64;
    for _ in 0..8 {
        let next = byte(reader)?;
        value = (value << 7) | u64::from(next & 0x7f);
        if next & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(invalid("oversized VCDIFF integer"))
}

fn section(program: &mut File, size: u64) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0; size as usize];
    program.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn decode(
    program: &mut File,
    base: &mut File,
    target_size: u64,
    output: &mut impl Write,
) -> io::Result<()> {
    let mut header = [0; 5];
    program.read_exact(&mut header)?;
    if header != [0xd6, 0xc3, 0xc4, 0, 0] {
        return Err(invalid(
            "expected VCDIFF with the default code table and no optional headers",
        ));
    }
    let length = program.metadata()?.len();
    let base_size = base.metadata()?.len();
    let mut remaining = target_size;
    let mut windows = 0;
    while program.stream_position()? < length {
        windows += 1;
        if windows > 65_536 {
            return Err(invalid("too many VCDIFF windows"));
        }
        let (source_size, source_offset) = match byte(program)? {
            0 => (0, 0),
            1 => {
                let size = number(program)?;
                let offset = number(program)?;
                if size == 0 || size > WINDOW || offset.saturating_add(size) > base_size {
                    return Err(invalid(
                        "VCDIFF source window is outside the base or exceeds 16 MiB",
                    ));
                }
                (size, offset)
            }
            _ => return Err(invalid("unsupported VCDIFF window flags")),
        };
        let delta_length = number(program)?;
        let end = program.stream_position()?.saturating_add(delta_length);
        let target_window = number(program)?;
        if target_window == 0 || target_window > WINDOW || target_window > remaining {
            return Err(invalid(
                "VCDIFF target window exceeds the target size or 16 MiB",
            ));
        }
        if byte(program)? != 0 {
            return Err(invalid("VCDIFF secondary compression is unsupported"));
        }
        let data = number(program)?;
        let instructions = number(program)?;
        let addresses = number(program)?;
        let sections = data.saturating_add(instructions).saturating_add(addresses);
        if data > target_window
            || sections > 2 * WINDOW
            || program.stream_position()?.saturating_add(sections) != end
            || end > length
        {
            return Err(invalid("invalid VCDIFF section sizes"));
        }
        remaining -= target_window;
        let mut data = Cursor::new(section(program, data)?);
        let mut instructions = Cursor::new(section(program, instructions)?);
        let mut addresses = Cursor::new(section(program, addresses)?);
        let mut bytes = vec![0; source_size as usize];
        base.seek(SeekFrom::Start(source_offset))?;
        base.read_exact(&mut bytes)?;
        let expected = (source_size + target_window) as usize;
        bytes.reserve(target_window as usize);
        let mut near = [0u64; 4];
        let mut same = [0u64; 768];
        let mut next_near = 0;
        while instructions.position() < instructions.get_ref().len() as u64 {
            let code = VCD_C_TABLE[byte(&mut instructions)? as usize];
            for inst in [code.first, code.second] {
                let size = match inst {
                    TableInst::NoOp => continue,
                    TableInst::Run => number(&mut instructions)?,
                    TableInst::Add { size } | TableInst::Copy { size, .. } => {
                        if size == 0 {
                            number(&mut instructions)?
                        } else {
                            u64::from(size)
                        }
                    }
                };
                if size == 0 || size > (expected - bytes.len()) as u64 {
                    return Err(invalid("VCDIFF instruction exceeds its target window"));
                }
                let size = size as usize;
                match inst {
                    TableInst::NoOp => unreachable!(),
                    TableInst::Run => {
                        let fill = byte(&mut data)?;
                        bytes.resize(bytes.len() + size, fill);
                    }
                    TableInst::Add { .. } => {
                        let start = bytes.len();
                        bytes.resize(start + size, 0);
                        data.read_exact(&mut bytes[start..])?;
                    }
                    TableInst::Copy { mode, .. } => {
                        let address = match mode {
                            0 => number(&mut addresses)?,
                            1 => (bytes.len() as u64)
                                .checked_sub(number(&mut addresses)?)
                                .ok_or_else(|| invalid("invalid VCDIFF HERE address"))?,
                            2..=5 => {
                                near[(mode - 2) as usize].saturating_add(number(&mut addresses)?)
                            }
                            6..=8 => {
                                same[(mode - 6) as usize * 256 + byte(&mut addresses)? as usize]
                            }
                            _ => return Err(invalid("unknown VCDIFF address mode")),
                        };
                        if address >= bytes.len() as u64 {
                            return Err(invalid(
                                "VCDIFF COPY address is outside the current window",
                            ));
                        }
                        near[next_near] = address;
                        next_near = (next_near + 1) % near.len();
                        let same_index = address as usize % same.len();
                        same[same_index] = address;
                        let mut left = size;
                        let offset = address as usize;
                        while left > 0 {
                            let available = left.min(bytes.len() - offset);
                            bytes.extend_from_within(offset..offset + available);
                            left -= available;
                        }
                    }
                }
            }
        }
        if bytes.len() != expected
            || data.position() != data.get_ref().len() as u64
            || addresses.position() != addresses.get_ref().len() as u64
        {
            return Err(invalid(
                "VCDIFF instructions do not match their window sections",
            ));
        }
        output.write_all(&bytes[source_size as usize..])?;
    }
    if remaining != 0 {
        return Err(invalid(
            "VCDIFF target length does not match the descriptor",
        ));
    }
    Ok(())
}

struct Target<'a> {
    file: &'a mut File,
    remaining: u64,
    hash: Sha256,
}

impl Write for Target<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(invalid("VCDIFF decoder exceeded the target size"));
        }
        let size = self.file.write(bytes)?;
        self.remaining -= size as u64;
        self.hash.update(&bytes[..size]);
        Ok(size)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

pub fn apply(
    root: &Path,
    mut base: File,
    patch: &mut dyn Read,
    patch_size: u64,
    budget: u64,
) -> io::Result<(File, u64, String)> {
    let mut length = [0; 8];
    let mut expected = [0; 32];
    patch.read_exact(&mut length)?;
    patch.read_exact(&mut expected)?;
    let size = u64::from_be_bytes(length);
    let base_size = base.metadata()?.len();
    if size < 1024 || base_size.saturating_add(patch_size).saturating_add(size) > budget {
        return Err(invalid(
            "VCDIFF reconstruction exceeds the available workspace input budget",
        ));
    }
    let mut program = tempfile::tempfile_in(root)?;
    io::copy(patch, &mut program)?;
    program.rewind()?;
    let mut result = tempfile::tempfile_in(root)?;
    let mut output = Target {
        file: &mut result,
        remaining: size,
        hash: Sha256::new(),
    };
    decode(&mut program, &mut base, size, &mut output)?;
    if output.remaining != 0 || output.hash.finalize()[..] != expected {
        return Err(invalid("reconstructed archive length or SHA-256 mismatch"));
    }
    result.rewind()?;
    let digest = expected
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((result, size, format!("sha256:{digest}")))
}
