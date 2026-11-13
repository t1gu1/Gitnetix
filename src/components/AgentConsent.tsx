import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConfig } from "../api/hooks";
import { AGENT_CONSENT, endAgentConsent, setAgentConsent, useAgentConsentAsk } from "../lib/agentConsent";
import { saveView } from "../lib/stored";
import { Modal } from "./ui";

/** Asks once, before the first agent starts, whether agents may act without asking each time. */
export function AgentConsent() {
  const qc = useQueryClient();
  const yes = useConfig().data?.ui.view?.[AGENT_CONSENT] === "1";
  useEffect(() => setAgentConsent(yes), [yes]);
  const asking = useAgentConsentAsk();
  if (!asking) return null;
  const allow = () => {
    void saveView(qc, AGENT_CONSENT, "1");
    endAgentConsent(true);
  };
  return (
    <Modal
      title="Agents act without asking"
      sub="Asked once, before the first agent starts"
      onClose={() => endAgentConsent(false)}
      width={480}
      footer={
        <>
          <button className="btn btn-md" autoFocus onClick={() => endAgentConsent(false)}>Back</button>
          <button className="btn btn-md btn-primary" onClick={allow}>Start agent</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        By default (Bypass), an agent runs its CLI with approvals turned off: it edits files and runs commands on this computer without asking first. With Claude Code, pick another mode under Permissions to allow its actions in the chat. Its request includes the linked ticket's text, written by whoever can edit that ticket.
      </p>
      <p style={{ margin: "10px 0 0", lineHeight: 1.55 }}>Start agents on repositories and tickets you trust.</p>
    </Modal>
  );
}
