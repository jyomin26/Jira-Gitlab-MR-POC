import axios from "axios";
import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";

const {
  GITLAB_PROJECT_ID,
  GITLAB_API_URL,
  GITLAB_TOKEN,
  GITLAB_AI_TOKEN,
  GITLAB_BRANCH_NAME,
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  GEMINI_API_KEY,
  GEMINI_MODEL
} = process.env;

const gitlabApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { "PRIVATE-TOKEN": GITLAB_TOKEN }
});

const gitlabAIAgentApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { "PRIVATE-TOKEN": GITLAB_AI_TOKEN }
});

// ---------------- Helpers ----------------
async function getMergeRequestByBranch(branchName) {
  const { data: mrs } = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests`, {
    params: { state: "opened", source_branch: branchName }
  });
  if (!mrs.length) return null;
  const mr = mrs[0];
  const { data: fullMR } = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}`);
  return fullMR;
}

async function getJiraDetails(ticketId) {
  try {
    const res = await axios.get(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`, {
      auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
      headers: { Accept: "application/json" }
    });
    return res.data;
  } catch {
    return null;
  }
}

function parseJiraDescription(adf) {
  if (!adf) return "";
  let text = "";
  function traverse(node) {
    if (node.type === "text") text += node.text || "";
    if (node.type === "hardBreak") text += "\n";
    if (node.content) node.content.forEach(traverse);
    if (node.type === "paragraph") text += "\n\n";
  }
  traverse(adf);
  return text.trim();
}

async function summarizeDiffs(diffText) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const prompt = `Summarize these code changes in bullet points for a GitLab MR:\n${diffText}`;
  const resp = await model.generateContent(prompt);
  return resp.response.text().trim();
}

// ---------------- Gemini Review & Jira Compliance ----------------
async function getReviewSuggestions(changes, jiraDescriptions) {
  console.log("🤖 Asking Gemini for code review + Jira compliance...");

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

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  // Pass Jira requirements as context to Gemini
  const prompt = `
You are a senior developer reviewing a GitLab MR.
Compare the changed files below against Jira ticket instructions:

Jira instructions:
${jiraDescriptions.join("\n\n")}

Files with line numbers:
${fileContents}

Return JSON ONLY:
[
  { "file": "<file path>", "line": <line number>, "suggestion": "<replacement code>", "note": "<explanation>" }
]
`;

  const result = await model.generateContent(prompt);
  let text = result.response.text().trim();
  if (text.startsWith("```")) text = text.replace(/```json|```/g, "").trim();

  try {
    const suggestions = JSON.parse(text);
    return suggestions.filter(s => changes.some(c => c.new_path === s.file));
  } catch (err) {
    console.error("❌ Failed to parse Gemini output:", text);
    return [];
  }
}

// ---------------- Add inline suggestion ----------------
async function addInlineSuggestionAsAIAgent(mr, suggestion, changes) {
  const { diff_refs } = mr;
  if (!diff_refs) return;
  const fileDiff = changes.find(c => c.new_path === suggestion.file);
  if (!fileDiff) return;

  try {
    await gitlabAIAgentApi.post(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/discussions`, {
      body: `\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\`\n**Note:** ${suggestion.note}`,
      position: {
        base_sha: diff_refs.base_sha,
        start_sha: diff_refs.start_sha,
        head_sha: diff_refs.head_sha,
        position_type: "text",
        new_path: suggestion.file,
        new_line: suggestion.line
      }
    });
    console.log(`✅ Added inline suggestion on ${suggestion.file}:${suggestion.line}`);
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

    const { data: changes } = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/diffs`);

    // Jira ticket details
    const jiraTickets = Array.from(new Set([...(GITLAB_BRANCH_NAME.match(/[A-Z]+-\d+/g) || [])]));
    const jiraDescriptions = [];
    let jiraText = "";

    for (const ticket of jiraTickets) {
      const data = await getJiraDetails(ticket);
      if (data) {
        const desc = parseJiraDescription(data.fields.description);
        jiraDescriptions.push(`Ticket ${ticket}: ${desc}`);
        jiraText += `### Jira: ${ticket}\n**Title:** ${data.fields.summary}\n**Description:** ${desc}\n**URL:** ${JIRA_BASE_URL}/browse/${ticket}\n\n`;
      } else {
        jiraDescriptions.push(`Ticket ${ticket}: Error fetching details`);
        jiraText += `### Jira: ${ticket} (Error fetching)\n\n`;
      }
    }

    // Diff summary
    let diffText = "";
    const seenFiles = new Set();
    for (const c of changes) {
      if (!seenFiles.has(c.new_path)) {
        diffText += `**${c.new_path}**\n\`\`\`diff\n${c.diff}\n\`\`\`\n`;
        seenFiles.add(c.new_path);
      }
    }
    const geminiSummary = await summarizeDiffs(diffText);

    // Update MR description
    const description = `## Changes in branch ${GITLAB_BRANCH_NAME}\n${jiraText}\n### Diff Summary (AI Generated)\n${geminiSummary}\n`;
    await gitlabApi.put(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}`, { description });
    console.log("✅ MR description updated");

    // Gemini review + Jira compliance suggestions
    const suggestions = await getReviewSuggestions(changes, jiraDescriptions);
    for (const s of suggestions) await addInlineSuggestionAsAIAgent(mr, s, changes);
    console.log("✅ Gemini + Jira compliance suggestions posted inline");
  } catch (err) {
    console.error("❌ Fatal error:", err);
  }
}

run();
