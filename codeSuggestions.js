import axios from "axios";
import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";

const {
  GITLAB_PROJECT_ID,
  GITLAB_API_URL,
  GITLAB_TOKEN,
  GITLAB_BRANCH_NAME,
  GEMINI_API_KEY,
  GEMINI_MODEL
} = process.env;

const gitlabApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { "PRIVATE-TOKEN": GITLAB_TOKEN }
});

// ---------------- Get MR by branch ----------------
async function getMergeRequestByBranch(branchName) {
  const { data: mrs } = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests`, {
    params: { state: "opened", source_branch: branchName }
  });

  if (!mrs.length) {
    console.log(`❌ No open MR found for branch: ${branchName}`);
    return null;
  }

  const mr = mrs[0];
  console.log(`📄 Found MR !${mr.iid}: ${mr.title}`);

  const { data: fullMR } = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}`);
  return fullMR;
}

// ---------------- Gemini helper ----------------
async function getReviewSuggestions(changes) {
console.log("🤖 Asking Gemini for code review suggestions...");

  // Prepare full file content with line numbers
  const fileContents = changes.map(c => {
    const lines = c.diff.split("\n");
    let content = `File: ${c.new_path}\n`;

    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        const match = /@@ -(\d+),\d+ \+(\d+),\d+ @@/.exec(line);
        if (match) {
          oldLine = parseInt(match[1]) - 1;
          newLine = parseInt(match[2]) - 1;
        }
        content += line + "\n";
      } else if (line.startsWith("+")) {
        newLine++;
        content += `+${newLine} ${line.substring(1)}\n`;
      } else if (line.startsWith("-")) {
        oldLine++;
        content += `-${oldLine} ${line.substring(1)}\n`;
      } else {
        oldLine++;
        newLine++;
        content += ` ${newLine} ${line.substring(1)}\n`;
      }
    }
    return content;
  }).join("\n\n");

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const prompt = `
You are a senior Android developer reviewing a GitLab MR.
Each file below contains its full content with line numbers.
For every changed file, provide **at least one improvement**, even if small (e.g., formatting, comments, best practices).
Return JSON ONLY in this format:

[
  { "file": "<file path>", "line": <line number>, "suggestion": "<replacement code>" }
]

Here are the files:

${fileContents}
`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();

    // Remove code block markers if present
    if (text.startsWith("```")) text = text.replace(/```json|```/g, "").trim();

    try {
      const suggestions = JSON.parse(text);
      // Filter suggestions to only include files actually changed
      return suggestions.filter(s =>
        changes.some(c => c.new_path === s.file)
      );
    } catch (err) {
      console.error("❌ Failed to parse Gemini output as JSON:", text);
      return [];
    }
  } catch (err) {
    console.error("❌ Gemini error:", err);
    return [];
  }
}


// ---------------- Add suggestion ----------------
async function addInlineSuggestion(mr, suggestion, changes) {
  const { diff_refs } = mr;
  if (!diff_refs) {
    console.log("❌ MR missing diff_refs, cannot add suggestion.");
    return;
  }

  // Only allow suggestions for files present in MR changes
  const fileDiff = changes.find(c => c.new_path === suggestion.file);
  if (!fileDiff) {
    console.log(`⚠️ File not found in MR changes: ${suggestion.file}`);
    return;
  }

  try {
    await gitlabApi.post(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/discussions`, {
      body: `\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\``,
      position: {
        base_sha: diff_refs.base_sha,
        start_sha: diff_refs.start_sha,
        head_sha: diff_refs.head_sha,
        position_type: "text",
        new_path: suggestion.file,
        new_line: suggestion.line
      }
    });
    console.log(`✅ Added suggestion inline on ${suggestion.file}:${suggestion.line}`);
  } catch (err) {
    console.error("❌ Error adding suggestion:", err.response?.data || err.message);
  }
}

// ---------------- Main Flow ----------------
async function run() {
  try {
    console.log(`🔍 Looking for MR for branch: ${GITLAB_BRANCH_NAME}`);
    const mr = await getMergeRequestByBranch(GITLAB_BRANCH_NAME);
    if (!mr) return;

    const { data: changes } = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/diffs`
    );

    let suggestions = await getReviewSuggestions(changes);

    // Filter Gemini suggestions to only files actually in MR diff
    suggestions = suggestions.filter(s =>
      changes.some(c => c.new_path === s.file)
    );

    if (!suggestions.length) {
      console.log("ℹ️ No valid suggestions for changed files.");
      return;
    }

    for (const s of suggestions) {
      await addInlineSuggestion(mr, s, changes);
    }

  } catch (err) {
    console.error("❌ Fatal error:", err);
  }
}

run();
