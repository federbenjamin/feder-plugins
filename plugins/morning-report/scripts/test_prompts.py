import json
import os
import re
import unittest

from hooks_ts import exported


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as source:
        return source.read()


def prompt(name):
    return read("prompts", name)


def plugin_name():
    return json.loads(read(".claude-plugin", "plugin.json"))["name"]


def prompt_names():
    return sorted(name for name in os.listdir(os.path.join(ROOT, "prompts")) if name.endswith(".md"))


PIPELINE = exported("pipeline")
STATUS = exported("status")
HEADINGS = [h["heading"] for h in PIPELINE["PROFILE_HEADINGS"]]
SCAN_TOOL = PIPELINE["SCAN_TOOL"]

# Which prompt holds each text the hook fills in place of a missing input, or branches on.
SENTINEL_READERS = {
    "SETUP_NO_PROFILE": "morning-setup.md",
    "SCAN_NO_SESSIONS": "morning-setup.md",
    "SUMMARY_NO_PROFILE": "summarizer.md",
}

# What the plugin no longer has: the narrative report, its review, the band, and the goal headings.
GONE = (
    "coaching",
    "morning-review",
    "Counts as progress",
    "What the report is for",
    "Working on",
    "remember all day",
    "priorities.md",
    "Fast track",
    "fast track",
    "launchCommand",
    "counts:",
)


def line_with(text, *needles):
    lines = [line for line in text.splitlines() if all(n in line for n in needles)]
    if len(lines) != 1:
        raise AssertionError(f"expected one line holding {needles!r}, found {len(lines)}")
    return lines[0]


class PromptContractTest(unittest.TestCase):
    def test_each_prompts_slots_are_the_keys_its_hook_fills(self):
        fills = PIPELINE["PROMPT_FILLS"]
        self.assertEqual(sorted(fills), prompt_names())
        for name in prompt_names():
            slots = set(re.findall(r"\{\{([A-Z_]+)\}\}", prompt(name)))
            self.assertEqual(slots, set(fills[name]), f"{name} slots differ from PROMPT_FILLS")

    def test_each_prompt_holds_the_exact_text_the_hook_fills_for_a_missing_input(self):
        for name, reader in SENTINEL_READERS.items():
            self.assertIn(name, PIPELINE, f"hooks/pipeline.ts exports no {name}")
            self.assertIn(PIPELINE[name], prompt(reader), f"{reader} does not hold {name}")

    def test_no_prompt_or_readme_names_what_was_removed(self):
        texts = {name: prompt(name) for name in prompt_names()}
        texts["README.md"] = read("README.md")
        for name, text in texts.items():
            for word in GONE:
                self.assertFalse(word in text, f"{name} names {word}")
            for form in ("/morning-setup goals", "/morning-setup scan", "scan [days]"):
                self.assertFalse(form in text, f"{name} names {form}")


class ProfileTest(unittest.TestCase):
    def test_the_profile_has_the_one_heading_status_ts_reads(self):
        self.assertEqual(HEADINGS, [STATUS["WATCH_FOR"]])

    def test_the_summarizer_names_the_heading_in_bold_and_the_setup_takes_it_from_the_fill(self):
        self.assertIn(f"**{STATUS['WATCH_FOR']}**", prompt("summarizer.md"))
        setup = prompt("morning-setup.md")
        self.assertEqual(setup.count("{{PROFILE_HEADINGS}}"), 1)
        self.assertNotIn(f"## {STATUS['WATCH_FOR']}", setup)


class StatusPromptTest(unittest.TestCase):
    def test_the_block_template_carries_every_line_and_the_date_line_status_ts_parses(self):
        text = prompt("status.md")
        template = text[text.index("~~~\n## <stream name>"):]
        for field in ("- repo:", "- what:", "- landed:", "- left:", "- waits on:", f"- {STATUS['LAST_TOUCHED']}: <YYYY-MM-DD>"):
            self.assertIn(field, template)

    def test_the_model_carries_every_stream_and_leaves_dropping_to_the_plugin(self):
        text = prompt("status.md")
        self.assertIn("Every stream carries", text)
        self.assertIn("its last touched date unchanged", text)
        self.assertIn(f"`## {STATUS['DROPPED_HEADING']}`", line_with(text, "the plugin adds them"))
        self.assertNotRegex(text, r"\b30\b")
        self.assertNotRegex(text, r"\boperator\b")


class PatternsPromptTest(unittest.TestCase):
    def test_the_lists_are_the_headings_status_ts_parses_and_judged_by_watch_for_only(self):
        text = prompt("patterns.md")
        self.assertEqual(text.count("{{WATCH_FOR}}"), 1)
        self.assertIn(f"### {STATUS['GOING_WELL']}", text)
        self.assertIn(f"### {STATUS['NOT_WORKING']}", text)
        self.assertIn(f"`{STATUS['NOTHING_SEEN']}`", text)
        self.assertIn("only when it fits something on the list above", line_with(text, "**Judge by the list only.**"))


class SummarizerPromptTest(unittest.TestCase):
    def test_friction_is_profile_specific_and_the_blocks_carry_stream_landed_and_open(self):
        text = prompt("summarizer.md")
        self.assertEqual(text.count("{{PROFILE}}"), 1)
        self.assertRegex(text, r"(?is)# Who the sessions belong to.*\{\{PROFILE\}\}")
        for line in ("stream: <", "landed: <", "open: <"):
            self.assertIn(line, text)
        self.assertRegex(text, r"(?is)friction:.*correcting.*arguing.*re-asking")
        self.assertIn(PIPELINE["SUMMARY_NO_PROFILE"], line_with(text, "- **friction:**"))
        self.assertNotRegex(text, r"\boperator\b")

    def test_summarizer_uses_a_generic_stream_form(self):
        for line in (line for line in prompt("summarizer.md").splitlines() if "stream:" in line):
            self.assertNotRegex(line, r'(?i)"|e\.g\.|for example|such as|like ')


class MorningSetupPromptTest(unittest.TestCase):
    def test_setup_interview_keeps_profile_writes_explicit(self):
        text = prompt("morning-setup.md")
        self.assertIn("(none)", text)
        self.assertIn("profile-{{TODAY}}-old.md", text)
        self.assertRegex(text, r"(?is)show it to them once.*stop")
        self.assertNotRegex(text, r"\boperator\b")
        self.assertIn("/morning-setup schedule", text)

    def test_consent_comes_first_then_the_scan_tool_then_the_one_round(self):
        text = prompt("morning-setup.md")
        consent, the_round = text.index("First: may the mod read their sessions?"), text.index("The round:")
        self.assertIn("{{PREVIEW}}", text[consent:the_round])
        self.assertIn("AskUserQuestion", text[consent:the_round])
        days = PIPELINE["SETUP_DAYS"]
        self.assertRegex(text[consent:the_round], rf"(?is)how many days.*from {days['min']} to {days['max']}.*skip")
        self.assertEqual(text.count(f"`{SCAN_TOOL}`"), 1)
        tool = text.index(f"`{SCAN_TOOL}`")
        self.assertLess(consent, tool)
        self.assertLess(tool, the_round)
        self.assertRegex(text[consent:tool], r"(?is)only if they said yes")
        self.assertIn("a few minutes", text[tool:the_round])
        self.assertEqual(text.count("Round "), 0)

    def test_the_prompt_names_the_tool_the_hook_registers_and_serves(self):
        register = read("hooks", "register.ts")
        self.assertIn(f"`{SCAN_TOOL}`", prompt("morning-setup.md"))
        self.assertIn(f"tool: 'mcp__{plugin_name()}__{SCAN_TOOL}'", register)
        self.assertIn("name: SCAN_TOOL,", register)

    def test_every_path_without_a_scan_still_runs_the_round(self):
        text = prompt("morning-setup.md")
        marker = PIPELINE["SCAN_NO_SESSIONS"]
        the_round = text.index("The round:")
        self.assertEqual(text.count(marker), 1)
        self.assertLess(text.index("{{PREVIEW}}"), text.index(marker))
        self.assertIn("nothing to read", text[text.index(marker):the_round])
        path = text[text.index("When they skipped"):the_round]
        for case in ("they skipped", "nothing to read", "anything but a file path"):
            self.assertIn(case, path)
        self.assertIn("the round starts from their own words alone", path)


class SetupScanPromptTest(unittest.TestCase):
    def test_the_scan_is_its_habits_section_alone(self):
        text = prompt("setup-scan.md")
        self.assertIn("## Habits", text)
        for gone in ("## Time by project", "## Streams seen", "computed facts"):
            self.assertNotIn(gone, text)


if __name__ == "__main__":
    unittest.main()
