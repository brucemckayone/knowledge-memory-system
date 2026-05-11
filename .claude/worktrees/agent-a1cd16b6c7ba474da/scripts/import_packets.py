#!/usr/bin/env python3
import os
import re
import subprocess
import sys
from pathlib import Path

# Configuration
# Run from the project root
WORK_PACKETS_DIR = Path("work-packets")
PHASES = ["phase1", "phase2", "phase3", "phase4", "phase5"]

# Store mapping of W-number to Issue ID
w_id_map = {}
dependency_list = []

def run_bd_command(args):
    try:
        result = subprocess.run(
            ["bd"] + args,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error running bd {' '.join(args)}: {e.stderr}")
        return None

def create_issue(title, description, parent_id=None, type="task"):
    args = ["create", title, "--type", type, "--description", description, "--silent"]
    if parent_id:
        args.extend(["--parent", parent_id])
    
    output = run_bd_command(args)
    if output:
        return output.strip()
    return None

def update_status(issue_id, status_text):
    status_lower = status_text.lower()
    if "complete" in status_lower or "✅" in status_lower:
        run_bd_command(["close", issue_id])
    elif "partial" in status_lower or "⚠️" in status_lower:
        run_bd_command(["update", issue_id, "--status", "in_progress"])

def parse_md_file(file_path):
    content = file_path.read_text()
    title_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else file_path.stem
    w_match = re.search(r"(W\d+)", title)
    w_num = w_match.group(1) if w_match else None
    status_match = re.search(r"\*\*Status:\*\*\s*(.+)$", content, re.MULTILINE)
    status = status_match.group(1).strip() if status_match else "Open"
    deps_match = re.search(r"\*\*Dependencies:\*\*\s*(.+)$", content, re.MULTILINE)
    deps_str = deps_match.group(1).strip() if deps_match else "None"
    
    # Description: Link to file + Objective
    desc = f"Source: [{file_path.name}]({file_path})\n\n"
    obj_match = re.search(r"## (?:Objective|Goal)([\s\S]+?)(?:##|---)", content)
    if obj_match:
        desc += "## Objective\n" + obj_match.group(1).strip()
    
    return {
        "title": title, "w_num": w_num, "status": status,
        "deps_str": deps_str, "description": desc
    }

def main():
    if not Path("work-packets").exists():
        print("work-packets dir not found. Run from repo root.")
        sys.exit(1)

    for phase in PHASES:
        phase_dir = WORK_PACKETS_DIR / phase
        if not phase_dir.exists(): continue
        
        print(f"Processing {phase}...")
        phase_title = phase.replace("phase", "Phase ").title()
        
        # Look for Phase title in README
        readme = phase_dir / "README.md"
        if readme.exists():
             match = re.search(r"^#\s+(Phase\s+\d+.*)$
", readme.read_text(), re.MULTILINE)
             if match: phase_title = match.group(1)

        phase_id = create_issue(phase_title, f"Tracking epic for {phase}", type="epic")
        if not phase_id: continue
        print(f"  Epic: {phase_id} - {phase_title}")

        for f in sorted(phase_dir.glob("W*.md")):
            data = parse_md_file(f)
            issue_id = create_issue(data["title"], data["description"], parent_id=phase_id)
            if issue_id:
                print(f"    Task: {issue_id} - {data['title']}")
                if data["w_num"]: w_id_map[data["w_num"]] = issue_id
                update_status(issue_id, data["status"])
                if data["deps_str"] and "None" not in data["deps_str"]:
                    deps = re.findall(r"(W\d+)", data["deps_str"])
                    for dep in deps: dependency_list.append((data["w_num"], dep))

    print("Linking dependencies...")
    for child_w, parent_w in dependency_list:
        child_id = w_id_map.get(child_w)
        parent_id = w_id_map.get(parent_w)
        if child_id and parent_id:
            run_bd_command(["dep", "add", child_id, parent_id])
            print(f"  {child_w} depends on {parent_w}")

if __name__ == "__main__":
    main()
