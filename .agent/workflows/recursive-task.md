---
description: Recursively execute a specific prompt/task over a set of directories or files.
---

# Recursive Task Executor

This workflow guides the agent to recursively process files within specified directories using a user-provided prompt.

1. **Context Collection**
   - ask: "What directories would you like to process? (Provide absolute paths or relative to workspace)"
   - ask: "What is the specific task or prompt you want to apply to each file/directory?"
   - ask: "Are there specific file patterns to match (e.g. `*.md`, `*.ts`) or exclude?"

2. **Discovery**
   - Based on the user's input, use the `find_by_name` tool to locate files.
     - Example: `find_by_name(SearchDirectory="/path/to/dir", Pattern="*.md")`
   - **CRITICAL**: If the user provided a list of directories, you must search *inside* them.
   - compile a list of all target files.

3. **Confirmation**
   - Present the list of files to be processed to the user.
   - ask: "I found [N] files. Ready to proceed with the task on these files?"
   - **STOP** if the user says no.

4. **Execution Loop**
   - Iterate through the list of files ONE BY ONE.
   - For each file:
     - **Context**: `view_file` to read the current content.
     - **Action**: Perform the user's specific task.
       - If it's a code edit, use `replace_file_content` or `multi_replace_file_content`.
       - If it's analysis, generate the analysis.
     - **Verification**: If the task implies a check (e.g., "fix lint errors"), verify immediately if possible.
   - **Progress**: After every few files (e.g., 5), briefly summarize progress to the user (optional, can be skipped if "turbo" is likely).

5. **Final Report**
   - Summarize total files processed.
   - List any files that failed or were skipped.
   - Ask the user if they want to review any specific changes.
