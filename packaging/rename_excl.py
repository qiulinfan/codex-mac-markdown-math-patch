#!/usr/bin/env python3
"""macOS renameatx_np(RENAME_EXCL): one-volume atomic, no-overwrite commit."""

import ctypes
import os
import sys


def main() -> None:
    if len(sys.argv) != 3 or sys.platform != "darwin":
        raise SystemExit("usage on macOS: rename_excl.py SOURCE DESTINATION")
    system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename = system.renameatx_np
    rename.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint
    ]
    rename.restype = ctypes.c_int
    at_fdcwd = -2
    rename_excl = 0x00000004
    if rename(
        at_fdcwd,
        os.fsencode(sys.argv[1]),
        at_fdcwd,
        os.fsencode(sys.argv[2]),
        rename_excl,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), sys.argv[2])


if __name__ == "__main__":
    main()
