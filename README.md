# Jira + GitLab Merge Request Automation with Gemini AI

This project contains two Node.js scripts to automate GitLab Merge Requests (MRs) and integrate QA suggestions using **Google Gemini AI** with Jira ticket compliance:

1. **postMR.js** – Summarizes MR code changes, posts inline review suggestions, and updates MR description with Jira compliance details.
2. **mergeMR.js** – Generates QA test case suggestions based on Jira acceptance criteria and MR changes, posts structured comments to Jira, assigns tickets to QA, and merges the MR automatically.

## Features

### Common Features
- Fetches GitLab Merge Requests for a specific branch.
- Retrieves Jira ticket details automatically.
- Uses **Google Gemini AI** to analyze code changes and acceptance criteria.

### `postMR.js` Specific
- Summarizes MR diffs using Gemini AI.
- Compares code changes against Jira ticket instructions.
- Posts inline code review suggestions directly in GitLab MR.
- Updates MR description with AI-generated summary and Jira context.

### `mergeMR.js` Specific
- Generates QA test case suggestions from Jira acceptance criteria and MR code changes.
- Posts structured comments to Jira tickets in **ADF format**.
- Assigns Jira ticket(s) to QA automatically.
- Merges the GitLab MR after QA suggestions are posted.

## Prerequisites

- Node.js >= 18
- npm or yarn
- GitLab project with a personal access token
- Jira account with API access
- Google Generative AI (Gemini) API key

---

## Environment Variables

Create a `.env` file in the project root:

```dotenv
# GitLab
GITLAB_PROJECT_ID=your_gitlab_project_id
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=your_gitlab_token
GITLAB_BRANCH_NAME=feature-branch

# Gemini AI
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.0-flash

# Jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_jira_api_token

# QA Assignment (for mergeMR.js)
JIRA_QA_EMAIL=qa_email@example.com
````

---

## Installation

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo
npm install
```

---

## Usage

### `postMR.js`

Run the script to fetch MR, summarize changes, and post inline review suggestions:

```bash
node postMR.js
```

* Workflow:

1. Fetch MR for the configured branch.
2. Retrieve Jira ticket details from branch name.
3. Summarize code changes with Gemini AI.
4. Update MR description with Jira and diff summary.
5. Post inline review suggestions in GitLab MR.

---

### `mergeMR.js`

Run the script to generate QA test case suggestions, update Jira, and merge MR:

```bash
node mergeMR.js
```

* Workflow:

1. Identify Jira ticket(s) from the branch name.
2. Fetch Jira ticket details and acceptance criteria.
3. Fetch MR and code changes for the branch.
4. Generate QA test case suggestions using Gemini AI.
5. Post structured comments to Jira in **ADF format**.
6. Assign Jira ticket(s) to QA.
7. Merge the GitLab MR automatically.

---

## Notes

* Branch names must include Jira ticket IDs (e.g., `PROJ-123-feature`).
* Gemini AI is used in both scripts for analyzing code changes and generating QA suggestions.
* Ensure your GitLab token has **API access** to update MRs and post discussions.
* Jira comments in `mergeMR.js` are posted in **ADF format** to maintain formatting.

---

## License

MIT License

---

## Acknowledgements

* [GitLab API](https://docs.gitlab.com/ee/api/)
* [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/)
* [Google Generative AI (Gemini)](https://developers.generativeai.google/)

```

