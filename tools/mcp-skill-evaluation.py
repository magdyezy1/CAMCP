"""Runs the mcp-builder skill's LLM evaluation runner against AMCP's evaluation fixture (QA-04).

The installed runner (scripts/evaluation.py with scripts/connections.py) hands a tool result's content blocks, which
the mcp package returns as pydantic models, to json.dumps, which cannot serialize them; every tool call would then
reach the model as an error text instead of AMCP's answer. This wrapper changes nothing on disk: it imports the runner's
own connections module, makes MCPConnection.call_tool return the blocks as plain JSON data, and runs evaluation.py,
unchanged, as __main__ with the arguments after "--".

The runner writes its report (-o) with Python's default encoding, which on Windows is a code page that cannot encode
the report's check marks, so a run would fail only after every question was asked. The wrapper therefore runs in
Python's UTF-8 mode (it restarts itself with -X utf8), creates the report's folder, and refuses a report file that
already exists, so a repeated run never overwrites an earlier one.

    python tools/mcp-skill-evaluation.py --skill-scripts <skill>/scripts -- -t stdio -c node \
        -a tests/fixtures/mcp-evaluation/server.mjs -m <model> -o <new report.md> \
        tests/fixtures/mcp-evaluation/evaluation.xml

The runner calls the Anthropic API with ANTHROPIC_API_KEY from the environment (the owner's key and usage); this
wrapper never reads it. See docs/OPERATIONS.md, "MCP evaluation set".
"""

import runpy
import subprocess
import sys
from pathlib import Path

USAGE = "Use: python tools/mcp-skill-evaluation.py --skill-scripts <skill scripts directory> -- <evaluation.py arguments>"


def plain(block):
    """A content block as JSON data: a pydantic model's dump, or the value itself."""
    dump = getattr(block, "model_dump", None)
    return dump(mode="json", exclude_none=True) if callable(dump) else block


def report_path(arguments):
    """The report file the runner's -o/--output names, if any."""
    for at, argument in enumerate(arguments):
        if argument in ("-o", "--output") and at + 1 < len(arguments):
            return Path(arguments[at + 1])
        if argument.startswith("--output="):
            return Path(argument.split("=", 1)[1])
    return None


def main(argv):
    if len(argv) < 3 or argv[0] != "--skill-scripts" or argv[2] != "--":
        sys.exit(USAGE)
    if not sys.flags.utf8_mode:
        sys.exit(subprocess.run([sys.executable, "-X", "utf8", str(Path(__file__).resolve()), *argv]).returncode)
    scripts = Path(argv[1]).resolve()
    runner = scripts / "evaluation.py"
    if not runner.is_file() or not (scripts / "connections.py").is_file():
        sys.exit("MCP_SKILL_RUNNER_NOT_FOUND: " + str(scripts) + " holds no evaluation.py and connections.py")
    report = report_path(argv[3:])
    if report is not None:
        if report.exists():
            sys.exit("MCP_SKILL_REPORT_EXISTS: " + str(report) + " exists; name a new report file")
        report.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(scripts))
    import connections  # the runner's module; evaluation.py imports this same object

    async def call_tool(self, tool_name, arguments):
        result = await self.session.call_tool(tool_name, arguments=arguments)
        return [plain(block) for block in result.content]

    connections.MCPConnection.call_tool = call_tool
    sys.argv = [str(runner), *argv[3:]]
    runpy.run_path(str(runner), run_name="__main__")


if __name__ == "__main__":
    main(sys.argv[1:])
