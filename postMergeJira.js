// run this script on CI/CD pipline
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------- CI/CD Variables ----------------
const {
  GITLAB_PROJECT_ID,
  GITLAB_BRANCH_NAME,    // GitLab branch name
  GEMINI_API_KEY,
  GEMINI_MODEL,
  JIRA_BASE_URL,
  JIRA_QA_EMAIL,
  JIRA_AI_AGENT_EMAIL,
  JIRA_AI_AGENT_TOKEN,
  GITLAB_TOKEN,
  GITLAB_API_URL
} = process.env;



// ---------------- Axios Instances ----------------
const gitlabApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { "PRIVATE-TOKEN": GITLAB_TOKEN }
});

const jiraApi = axios.create({
  baseURL: JIRA_BASE_URL,
  auth: { username: JIRA_AI_AGENT_EMAIL, password: JIRA_AI_AGENT_TOKEN },
  headers: { "Content-Type": "application/json" }
});

// ---------------- Jira Helpers ----------------
async function getJiraDetails(ticketId) {
  try {
    const res = await jiraApi.get(`/rest/api/3/issue/${ticketId}`, {
      headers: { Accept: "application/json" }
    });
    return res.data;
  } catch (err) {
    console.error(`❌ Error fetching Jira ticket ${ticketId}:`, err.response?.data || err.message);
    return null;
  }
}

async function getJiraUserAccountId(email) {
  const res = await jiraApi.get(`/rest/api/3/user/search`, { params: { query: email } });
  if (!res.data.length) throw new Error(`No Jira user found for ${email}`);
  return res.data[0].accountId;
}

// ---------------- GitLab Helpers ----------------
async function getMergeRequest(branchName) {
  const res = await gitlabApi.get(
    `/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}/merge_requests`,
    { params: { source_branch: branchName, state: "merged" } }
  );
  return res.data[0];
}

async function getMRChanges(mr) {
  const { data: changes } = await gitlabApi.get(
    `/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}/diffs`
  );
  return changes;
}

// ---------------- Gemini Helper ----------------
async function getQASuggestions(jiraText, changes) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `
Jira: ${jiraText}
Code Changes: ${changes.map(c => `File: ${c.new_path}\nDiff:\n${c.diff}`).join("\n")}

Task: Provide short, clear QA test cases.

⚠️ Format the answer in MARKDOWN with:
- Headings using ##
- Bullet points using *
- No other formatting.
`;

  const response = await model.generateContent(prompt);
  return response.response.text();
}


function buildJiraADFFromText(text) {
  const lines = text.split("\n");
  const content = [];

  for (let line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("## ")) {
      content.push({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: line.replace("## ", "") }]
      });
    } else if (line.startsWith("# ")) {
      content.push({
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: line.replace("# ", "") }]
      });
    } else if (line.trim().startsWith("* ") || line.trim().startsWith("- ")) {
      if (
        content.length === 0 ||
        content[content.length - 1].type !== "bulletList"
      ) {
        content.push({ type: "bulletList", content: [] });
      }
      content[content.length - 1].content.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: line.replace(/^(\*|-)\s+/, "") }]
          }
        ]
      });
    } else {
      content.push({
        type: "paragraph",
        content: [{ type: "text", text: line }]
      });
    }
  }

  return { type: "doc", version: 1, content };
}


async function updateJira(ticketId, commentText, qaEmail) {
  const qaAccountId = await getJiraUserAccountId(qaEmail);

  // Post comment as AI agent
  await jiraApi.post(`/rest/api/3/issue/${ticketId}/comment`, {
    body: buildJiraADFFromText(commentText)
  });

  // Assign QA
  await jiraApi.put(`/rest/api/3/issue/${ticketId}/assignee`, {
    accountId: qaAccountId
  });
}

// ---------------- Main ----------------
(async function main() {
const branchName = GITLAB_BRANCH_NAME
console.log("Branch name detected:", branchName);
  try {
    const jiraTickets = Array.from(new Set([...(branchName.match(/[A-Z]+-\d+/g) || [])]));
    if (!jiraTickets.length) {
      console.warn("⚠️ No Jira ticket found in branch name, skipping Jira update.");
      process.exit(0);
    }

    const mr = await getMergeRequest(branchName);
    if (!mr) {
      console.warn("⚠️ No merged MR found for branch, skipping Jira update.");
      process.exit(0);
    }

    const changes = await getMRChanges(mr);

    for (const ticket of jiraTickets) {
      const data = await getJiraDetails(ticket);
      if (!data) continue;

      const jiraText = `Title: ${data.fields.summary}\nURL: ${JIRA_BASE_URL}/browse/${ticket}`;

      console.log("🤖 Generating QA suggestions for ${ticket}...");
      const qaText = await getQASuggestions(jiraText, changes);

      console.log("💬 Posting concise comment to Jira ticket ${ticket}...");
      await updateJira(ticket, qaText, JIRA_QA_EMAIL);
    }

    console.log("🎉 Done! Jira updated, QA assigned.");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    process.exit(1);
  }
})();
