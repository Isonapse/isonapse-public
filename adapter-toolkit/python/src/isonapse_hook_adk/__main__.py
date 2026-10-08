"""Create a native-callback starter, without modifying the Isonapse install."""
import argparse
from pathlib import Path

STARTER = '''"""Run only after reviewing and registering this exact entrypoint."""
import argparse
import sys
from pathlib import Path
from isonapse_hook_adk import Client, InstalledHook
from isonapse_hook_adk.runtime import Runtime

parser = argparse.ArgumentParser()
parser.add_argument("--hook", type=Path, required=True)
parser.add_argument("--hook-sha256", required=True)
parser.add_argument("--host", required=True)
parser.add_argument("--session", required=True)
parser.add_argument("--file", type=Path, required=True)
args = parser.parse_args()
# These arguments are operator settings, never model-authored tool arguments.
runtime = Runtime(Client(InstalledHook(args.hook, args.hook_sha256), args.host),
                  args.session, str(Path.cwd()), lambda message: print(message, file=sys.stderr))
runtime.start()
def native_read(inputs):
    # This callback executes the authorized path, never the original args.file.
    with open(inputs["file_path"], "rb") as source:
        value = source.read(65537)
    if len(value) > 65536:
        raise ValueError("example file exceeds 64 KiB")
    return value.decode("utf-8")
result = runtime.tool("read-1", "Read", {"file_path":str(args.file.resolve())}, native_read)
print(result)
runtime.end()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser("init", help="create a new starter file; never overwrite")
    initialize.add_argument("destination", type=Path)
    args = parser.parse_args()
    with args.destination.open("x", encoding="utf-8") as output:
        output.write(STARTER)
    print("Created native Read callback. Review it, then use isonapse hook host-profile create/validate/register.")

if __name__ == "__main__":
    main()
