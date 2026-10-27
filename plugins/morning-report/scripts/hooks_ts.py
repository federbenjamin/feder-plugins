"""A hooks/*.ts module as the Python tests read it, through node: its exported values, and a call of one of its functions."""
import functools
import json
import pathlib
import subprocess

HOOKS = pathlib.Path(__file__).resolve().parent.parent / "hooks"
VALUES = "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v !== 'function')))))"
CALL = "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(m[process.argv[2]](JSON.parse(process.argv[3])))))"


def node(module, script, *args):
    r = subprocess.run(["node", "-e", script, (HOOKS / f"{module}.ts").as_uri(), *args], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


@functools.cache
def exported(module):
    return node(module, VALUES)


def call(module, name, arg):
    return node(module, CALL, name, json.dumps(arg))
