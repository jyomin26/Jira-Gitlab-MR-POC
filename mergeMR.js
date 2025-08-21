import axios from "axios";
import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------- Env Vars ----------------
const {
  GITLAB_PROJECT_ID,
  GITLAB_API_URL,
  GITLAB_TOKEN,
  GITLAB_BRANCH_NAME,
  GEMINI_API_KEY,
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_QA_EMAIL,
  JIRA_AI_AGENT_EMAIL,
  JIRA_AI_AGENT_TOKEN

} = process.env;

// ---------------- Axios Instances ----------------
const gitlabApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
});

const jiraApi = axios.create({
  baseURL: JIRA_BASE_URL,
  auth: { username: JIRA_AI_AGENT_EMAIL, password: JIRA_AI_AGENT_TOKEN },
  headers: { "Content-Type": "application/json" }
});

// ---------------- Jira Helpers ----------------
async function getJiraDetails(ticketId) {
  try {
    const res = await axios.get(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`, {
      auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
      headers: { Accept: "application/json" }
    });
    return res.data;
  } catch (err) {
    console.error(`❌ Error fetching Jira ticket ${ticketId}:`, err.response?.data || err.message);
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

async function getJiraUserAccountId(email) {
  const res = await jiraApi.get(`/rest/api/3/user/search`, {
    params: { query: email }
  });
  if (!res.data.length) throw new Error(`No Jira user found for ${email}`);
  return res.data[0].accountId;
}

// ---------------- GitLab Helpers ----------------
async function getMergeRequest(branchName) {
  const res = await gitlabApi.get(
    `/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}/merge_requests`,
    { params: { source_branch: branchName, state: "opened" } }
  );
  return res.data[0];
}

async function getMRChanges(mr) {
  const { data: changes } = await gitlabApi.get(
    `/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/diffs`
  );
  return changes;
}

async function mergeMR(mrIid) {
  try {
    await gitlabApi.put(
      `/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}/merge_requests/${mrIid}/merge`,
      {},
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`✅ MR !${mrIid} merged successfully`);
  } catch (err) {
    console.error("❌ GitLab Merge Error:", err.response?.data || err.message);
    throw err;
  }
}

// ---------------- Gemini Helper ----------------
async function getQASuggestions(jiraText, changes) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `
We have a Jira story and GitLab code changes.

Jira Details:
${jiraText}

Code Changes:
${changes.map(c => `File: ${c.new_path}\nDiff:\n${c.diff}`).join("\n\n")}

Task:
Generate concise QA test cases and summary for QA, suitable to post directly as a Jira comment. Be short, clear, and actionable.
`;

  const response = await model.generateContent(prompt);
  return response.response.text();
}

// ---------------- Jira ADF Builder (bold, bullets, paragraphs) ----------------
function buildJiraADFFromText(text) {
 const lines = text.split("\n");
  const content = [];
  let currentList = null;
  let inCodeBlock = false;
  let codeText = "";
  let codeLang = "text";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeText = "";
        codeLang = trimmed.slice(3) || "text";
      } else {
        inCodeBlock = false;
        content.push({
          type: "codeBlock",
          attrs: { language: codeLang },
          content: [{ type: "text", text: codeText }]
        });
      }
      continue;
    }

    if (inCodeBlock) {
      codeText += line + "\n";
      continue;
    }

    if (trimmed.startsWith("•")) {
      if (!currentList) currentList = { type: "bulletList", content: [] };
      currentList.content.push({
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text: trimmed.slice(1).trim() }] }]
      });
    } else {
      if (currentList) {
        content.push(currentList);
        currentList = null;
      }
      if (trimmed.startsWith("###")) {
        content.push({
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: trimmed.replace(/^###\s*/, "") }]
        });
      } else if (trimmed) {
        const isBold = /^\*\*(.+)\*\*$/.test(trimmed);
        content.push({
          type: "paragraph",
          content: [{ type: "text", text: trimmed.replace(/\*\*/g, ""), marks: isBold ? [{ type: "strong" }] : [] }]
        });
      } else {
        content.push({ type: "paragraph", content: [{ type: "text", text: "" }] });
      }
    }
  }

  if (currentList) content.push(currentList);
  return { type: "doc", version: 1, content };
}



// ---------------- Jira Update ----------------
async function updateJira(ticketId, commentText, qaEmail) {
  const qaAccountId = await getJiraUserAccountId(qaEmail);

  // Post structured comment
  await jiraApi.post(`/rest/api/3/issue/${ticketId}/comment`, {
    body: buildJiraADFFromText(commentText)
  });

  // Assign to QA
  await jiraApi.put(`/rest/api/3/issue/${ticketId}/assignee`, {
    accountId: qaAccountId
  });
}

// ---------------- Main ----------------
(async function main() {
  try {
    const jiraTickets = Array.from(new Set([...(GITLAB_BRANCH_NAME.match(/[A-Z]+-\d+/g) || [])]));
    if (!jiraTickets.length) throw new Error("No Jira ticket found in branch name");

    console.log(`🔗 Jira Tickets: ${jiraTickets.join(", ")}`);

    const mr = await getMergeRequest(GITLAB_BRANCH_NAME);
    if (!mr) throw new Error("No open MR found for branch");

    console.log(`📂 Found MR: !${mr.iid} - ${mr.title}`);

    const changes = await getMRChanges(mr);

    // Fetch Jira details and construct text for Gemini
    let jiraText = "";
    for (const ticket of jiraTickets) {
      const data = await getJiraDetails(ticket);
      if (data) {
        const desc = parseJiraDescription(data.fields.description);
        jiraText += `### Jira: ${ticket}\n**Title:** ${data.fields.summary}\n**Description:** ${desc}\n**URL:** ${JIRA_BASE_URL}/browse/${ticket}\n\n`;

        console.log(`📄 Jira: ${ticket} - ${data.fields.summary}`);

        // Gemini suggestions
        console.log(`🤖 Generating QA suggestions for ${ticket}...`);
        const qaText = await getQASuggestions(jiraText, changes);

        // Post structured comment to Jira
        console.log(`💬 Posting structured comment to Jira ticket ${ticket}...`);
        await updateJira(ticket, qaText, JIRA_QA_EMAIL);
      } else {
        console.log(`❌ Skipping Jira ticket ${ticket} (not found)`);
      }
    }

    // Merge MR
    console.log(`🔀 Merging MR...`);
    await mergeMR(mr.iid);

    console.log("🎉 Done! MR merged, Jira updated, QA assigned.");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
})();
