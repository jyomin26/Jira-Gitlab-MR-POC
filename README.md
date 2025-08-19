# JIRA GitLab MR Review with Gemini AI & Jira Compliance

This postMR.js project automates GitLab Merge Request (MR) reviews by integrating **Google Gemini AI** for code suggestions and cross-checking them against **Jira ticket requirements**. It can summarize code changes, update MR descriptions, and post inline suggestions for review.

---

## Features

- Fetches GitLab Merge Requests for a specific branch.
- Retrieves Jira ticket details automatically.
- Summarizes MR diffs using Google Gemini AI.
- Compares code changes against Jira ticket instructions.
- Posts inline code review suggestions directly in GitLab MR.
- Updates MR description with AI-generated summary and Jira context.

---

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
GITLAB_PROJECT_ID=your_gitlab_project_id
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=your_gitlab_token
GITLAB_BRANCH_NAME=feature-branch
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_jira_api_token
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.0-flash
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

Run the script to fetch MR, summarize changes, and post suggestions:

```bash
node postMR.js
```

* The script will:

  1. Fetch the MR for the configured branch.
  2. Retrieve Jira ticket details mentioned in the branch name (e.g., `PROJ-123`).
  3. Summarize the code changes with Gemini AI.
  4. Update the MR description with Jira and diff summary.
  5. Post inline review suggestions based on Gemini AI analysis.

---

## Notes

* Branch names must include Jira ticket IDs (e.g., `PROJ-123-feature`).
* Inline suggestions are only posted for files changed in the MR.
* Ensure your GitLab token has **API access** to update MRs and post discussions.

---

## License

MIT License

---

## Acknowledgements

* [GitLab API](https://docs.gitlab.com/ee/api/)
* [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/)
* [Google Generative AI (Gemini)](https://developers.generativeai.google/)

```

---


