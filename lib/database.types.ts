// Hand-written to mirror supabase/schema.sql until we move to the
// supabase CLI. Keep these two files in lockstep — when one changes,
// update the other in the same commit.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Three states, never two. "no" is a recorded negative; "unknown" means we
 * did not check. Everything crossing an integration boundary in this
 * codebase has to say which of the two it means, and the ledger's columns
 * are typed so a caller cannot quietly write one for the other.
 */
export type Tristate = "yes" | "no" | "unknown";

export type PrescriptionKind = "question" | "end_commitment" | "next_step" | "avoid";
export type PrescriptionSource = "briefing" | "recap";

export type Database = {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string;
          slug: string;
          name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      deals: {
        Row: {
          id: string;
          tenant_id: string;
          external_id: string | null;
          account: string;
          industry: string | null;
          arr: number | null;
          stage_key: string;
          days_in_stage: number | null;
          rep_forecast_probability: number | null;
          rep_forecast_close_date: string | null;
          rep_notes: string | null;
          framework_id: string | null;
          outcome_label: "won" | "lost" | null;
          outcome_recorded_at: string | null;
          outcome_opportunity_id: string | null;
          outcome_close_date: string | null;
          outcome_reason: string | null;
          outcome_amount: number | null;
          dealripe_last_writeback_at: string | null;
          dealripe_last_write_hash: string | null;
          dealripe_last_next_step: string | null;
          rep_email: string | null;
          rolldog_opportunity_id: string | null;
          rolldog_link_confidence: string | null;
          salesforce_account_id: string | null;
          salesforce_link_confidence: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          external_id?: string | null;
          account: string;
          industry?: string | null;
          arr?: number | null;
          stage_key: string;
          days_in_stage?: number | null;
          rep_forecast_probability?: number | null;
          rep_forecast_close_date?: string | null;
          rep_notes?: string | null;
          framework_id?: string | null;
          outcome_label?: "won" | "lost" | null;
          outcome_recorded_at?: string | null;
          outcome_opportunity_id?: string | null;
          outcome_close_date?: string | null;
          outcome_reason?: string | null;
          outcome_amount?: number | null;
          dealripe_last_writeback_at?: string | null;
          dealripe_last_write_hash?: string | null;
          dealripe_last_next_step?: string | null;
          rep_email?: string | null;
          rolldog_opportunity_id?: string | null;
          rolldog_link_confidence?: string | null;
          salesforce_account_id?: string | null;
          salesforce_link_confidence?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          external_id?: string | null;
          account?: string;
          industry?: string | null;
          arr?: number | null;
          stage_key?: string;
          days_in_stage?: number | null;
          rep_forecast_probability?: number | null;
          rep_forecast_close_date?: string | null;
          rep_notes?: string | null;
          framework_id?: string | null;
          outcome_label?: "won" | "lost" | null;
          outcome_recorded_at?: string | null;
          outcome_opportunity_id?: string | null;
          outcome_close_date?: string | null;
          outcome_reason?: string | null;
          outcome_amount?: number | null;
          dealripe_last_writeback_at?: string | null;
          dealripe_last_write_hash?: string | null;
          dealripe_last_next_step?: string | null;
          rep_email?: string | null;
          rolldog_opportunity_id?: string | null;
          rolldog_link_confidence?: string | null;
          salesforce_account_id?: string | null;
          salesforce_link_confidence?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          external_id: string | null;
          name: string;
          role: string | null;
          relationship:
            | "champion"
            | "influencer"
            | "economic_buyer"
            | "user"
            | "unknown";
          last_contacted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          external_id?: string | null;
          name: string;
          role?: string | null;
          relationship:
            | "champion"
            | "influencer"
            | "economic_buyer"
            | "user"
            | "unknown";
          last_contacted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          external_id?: string | null;
          name?: string;
          role?: string | null;
          relationship?:
            | "champion"
            | "influencer"
            | "economic_buyer"
            | "user"
            | "unknown";
          last_contacted_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      calls: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          external_id: string | null;
          call_date: string | null;
          duration_minutes: number | null;
          participants: Json | null;
          source: "gong" | "manual_paste" | "recall_ai" | null;
          transcript_id: string | null;
          has_been_extracted: boolean;
          extraction_completed_at: string | null;
          recall_bot_id: string | null;
          ingest_error: string | null;
          briefing_sent_at: string | null;
          scheduled_start: string | null;
          outcome: string | null;
          meeting_type: string | null;
          title: string | null;
          call_subtype: string | null;
          organizer_email: string | null;
          capture_evidence: "observed" | "unavailable" | "not_checked";
          capture_class:
            | "captured"
            | "no_show"
            | "lobby_timeout"
            | "lobby_refused"
            | "never_joined"
            | "media_lost"
            | "unknown"
            | null;
          capture_sub_code: string | null;
          capture_detail: string | null;
          capture_status_changes: Json | null;
          capture_checked_at: string | null;
          ingest_failure_class:
            | "provider"
            | "auth"
            | "rate_limit"
            | "billing"
            | "content"
            | "unknown"
            | null;
          ingest_content_attempts: number;
          ingest_infra_attempts: number;
          ingest_retry_after: string | null;
          followup_draft_state:
            | "not_attempted"
            | "drafted"
            | "held"
            | "failed"
            | "unavailable";
          followup_draft_reason: string | null;
          followup_draft_attempts: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          external_id?: string | null;
          call_date?: string | null;
          duration_minutes?: number | null;
          participants?: Json | null;
          source?: "gong" | "manual_paste" | "recall_ai" | null;
          transcript_id?: string | null;
          has_been_extracted?: boolean;
          extraction_completed_at?: string | null;
          recall_bot_id?: string | null;
          ingest_error?: string | null;
          briefing_sent_at?: string | null;
          scheduled_start?: string | null;
          outcome?: string | null;
          meeting_type?: string | null;
          title?: string | null;
          call_subtype?: string | null;
          organizer_email?: string | null;
          capture_evidence?: "observed" | "unavailable" | "not_checked";
          capture_class?:
            | "captured"
            | "no_show"
            | "lobby_timeout"
            | "lobby_refused"
            | "never_joined"
            | "media_lost"
            | "unknown"
            | null;
          capture_sub_code?: string | null;
          capture_detail?: string | null;
          capture_status_changes?: Json | null;
          capture_checked_at?: string | null;
          ingest_failure_class?:
            | "provider"
            | "auth"
            | "rate_limit"
            | "billing"
            | "content"
            | "unknown"
            | null;
          ingest_content_attempts?: number;
          ingest_infra_attempts?: number;
          ingest_retry_after?: string | null;
          followup_draft_state?:
            | "not_attempted"
            | "drafted"
            | "held"
            | "failed"
            | "unavailable";
          followup_draft_reason?: string | null;
          followup_draft_attempts?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          external_id?: string | null;
          call_date?: string | null;
          duration_minutes?: number | null;
          participants?: Json | null;
          source?: "gong" | "manual_paste" | "recall_ai" | null;
          transcript_id?: string | null;
          has_been_extracted?: boolean;
          extraction_completed_at?: string | null;
          recall_bot_id?: string | null;
          ingest_error?: string | null;
          briefing_sent_at?: string | null;
          scheduled_start?: string | null;
          outcome?: string | null;
          meeting_type?: string | null;
          title?: string | null;
          call_subtype?: string | null;
          organizer_email?: string | null;
          capture_evidence?: "observed" | "unavailable" | "not_checked";
          capture_class?:
            | "captured"
            | "no_show"
            | "lobby_timeout"
            | "lobby_refused"
            | "never_joined"
            | "media_lost"
            | "unknown"
            | null;
          capture_sub_code?: string | null;
          capture_detail?: string | null;
          capture_status_changes?: Json | null;
          capture_checked_at?: string | null;
          ingest_failure_class?:
            | "provider"
            | "auth"
            | "rate_limit"
            | "billing"
            | "content"
            | "unknown"
            | null;
          ingest_content_attempts?: number;
          ingest_infra_attempts?: number;
          ingest_retry_after?: string | null;
          followup_draft_state?:
            | "not_attempted"
            | "drafted"
            | "held"
            | "failed"
            | "unavailable";
          followup_draft_reason?: string | null;
          followup_draft_attempts?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      transcripts: {
        Row: {
          id: string;
          tenant_id: string;
          call_id: string;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          call_id: string;
          body: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          call_id?: string;
          body?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      field_extractions: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          framework_field_key: string;
          framework_id: string | null;
          status: "Yes" | "No" | "Unknown";
          answer: string | null;
          evidence: string | null;
          confidence: number | null;
          last_updated_from_call_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          framework_field_key: string;
          framework_id?: string | null;
          status: "Yes" | "No" | "Unknown";
          answer?: string | null;
          evidence?: string | null;
          confidence?: number | null;
          last_updated_from_call_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          framework_field_key?: string;
          framework_id?: string | null;
          status?: "Yes" | "No" | "Unknown";
          answer?: string | null;
          evidence?: string | null;
          confidence?: number | null;
          last_updated_from_call_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      extraction_runs: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          call_id: string | null;
          model_name: string;
          prompt_version: string | null;
          raw_response: Json | null;
          token_input: number | null;
          token_output: number | null;
          duration_ms: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          call_id?: string | null;
          model_name: string;
          prompt_version?: string | null;
          raw_response?: Json | null;
          token_input?: number | null;
          token_output?: number | null;
          duration_ms?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          call_id?: string | null;
          model_name?: string;
          prompt_version?: string | null;
          raw_response?: Json | null;
          token_input?: number | null;
          token_output?: number | null;
          duration_ms?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      briefing_runs: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          model_name: string;
          prompt_version: string | null;
          raw_response: Json | null;
          token_input: number | null;
          token_output: number | null;
          duration_ms: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          model_name: string;
          prompt_version?: string | null;
          raw_response?: Json | null;
          token_input?: number | null;
          token_output?: number | null;
          duration_ms?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          model_name?: string;
          prompt_version?: string | null;
          raw_response?: Json | null;
          token_input?: number | null;
          token_output?: number | null;
          duration_ms?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      crm_access_log: {
        Row: {
          id: string;
          tenant_id: string;
          operation: "read" | "write";
          opportunity_external_id: string;
          fields: Json;
          allowed: boolean;
          violation_reason: string | null;
          call_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          operation: "read" | "write";
          opportunity_external_id: string;
          fields: Json;
          allowed: boolean;
          violation_reason?: string | null;
          call_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          operation?: "read" | "write";
          opportunity_external_id?: string;
          fields?: Json;
          allowed?: boolean;
          violation_reason?: string | null;
          call_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      qualification_frameworks: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          source: "builtin" | "rolldog" | "manual";
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          source: "builtin" | "rolldog" | "manual";
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          source?: "builtin" | "rolldog" | "manual";
          created_at?: string;
        };
        Relationships: [];
      };
      framework_fields: {
        Row: {
          id: string;
          tenant_id: string;
          framework_id: string;
          field_key: string;
          label: string;
          question: string;
          stage_key: string | null;
          write_target: Json | null;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          framework_id: string;
          field_key: string;
          label: string;
          question: string;
          stage_key?: string | null;
          write_target?: Json | null;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          framework_id?: string;
          field_key?: string;
          label?: string;
          question?: string;
          stage_key?: string | null;
          write_target?: Json | null;
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      deal_signal_snapshots: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          snapshot_date: string;
          signals: Json;
          dealripe_forecast: Json | null;
          rep_commit: string | null;
          outcome_label: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          snapshot_date: string;
          signals: Json;
          dealripe_forecast?: Json | null;
          rep_commit?: string | null;
          outcome_label?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          snapshot_date?: string;
          signals?: Json;
          dealripe_forecast?: Json | null;
          rep_commit?: string | null;
          outcome_label?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      /**
       * The prescription ledger. See supabase/add-prescription-ledger.sql.
       *
       * followed and the three outcome columns are three-state on purpose.
       * "unknown" means we did not check (no transcript, no calendar, no
       * Rolldog block) and is never interchangeable with "no".
       */
      prescribed_actions: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          call_id: string;
          issued_at: string;
          kind: PrescriptionKind;
          text: string;
          source: PrescriptionSource;
          followed: Tristate;
          followed_evidence: string | null;
          scored_at: string | null;
          email_checked_at: string | null;
          outcome_next_meeting: Tristate;
          outcome_draft_sent: Tristate;
          /** PROOF: the customer's CRM said the stage moved. Safe to show a CRO. */
          outcome_stage_moved: Tristate;
          /** LEARNING: our own extraction newly evidenced fields. Never shown as proof. */
          outcome_qualification_advanced: Tristate;
          /** Why each outcome is what it is, keyed by column name. Null on rows
           *  scored before reasons were persisted. */
          outcome_reasons: Json | null;
          /** Null on rows recovered by parsing a sent briefing email. */
          framework_field_keys: string[] | null;
          created_at: string;
          outcome_label: string | null;
          /** DEPRECATED, superseded by `followed`. Nothing writes it. */
          asked_on_next_call: boolean | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          call_id: string;
          issued_at?: string;
          kind: PrescriptionKind;
          text: string;
          source: PrescriptionSource;
          followed?: Tristate;
          followed_evidence?: string | null;
          scored_at?: string | null;
          email_checked_at?: string | null;
          outcome_next_meeting?: Tristate;
          outcome_draft_sent?: Tristate;
          outcome_stage_moved?: Tristate;
          outcome_qualification_advanced?: Tristate;
          outcome_reasons?: Json | null;
          framework_field_keys?: string[] | null;
          created_at?: string;
          outcome_label?: string | null;
          asked_on_next_call?: boolean | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          call_id?: string;
          issued_at?: string;
          kind?: PrescriptionKind;
          text?: string;
          source?: PrescriptionSource;
          followed?: Tristate;
          followed_evidence?: string | null;
          scored_at?: string | null;
          email_checked_at?: string | null;
          outcome_next_meeting?: Tristate;
          outcome_draft_sent?: Tristate;
          outcome_stage_moved?: Tristate;
          outcome_qualification_advanced?: Tristate;
          outcome_reasons?: Json | null;
          framework_field_keys?: string[] | null;
          created_at?: string;
          outcome_label?: string | null;
          asked_on_next_call?: boolean | null;
        };
        Relationships: [];
      };
      deal_messages: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          /** RFC 5322 Message-ID, stable across mailboxes. The dedupe key. */
          internet_message_id: string;
          /** Graph's own id, which is PER-MAILBOX. Kept only to fetch a body. */
          graph_message_id: string;
          mailbox: string;
          conversation_id: string | null;
          direction: "inbound" | "outbound";
          from_email: string | null;
          from_domain: string | null;
          to_emails: string[];
          cc_emails: string[];
          subject: string | null;
          sent_at: string | null;
          /** "Accepted:" / "Declined:". A mail client answering, not a person. */
          is_calendar_response: boolean;
          customer_side: boolean;
          first_seen_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          internet_message_id: string;
          graph_message_id: string;
          mailbox: string;
          conversation_id?: string | null;
          direction: "inbound" | "outbound";
          from_email?: string | null;
          from_domain?: string | null;
          to_emails?: string[];
          cc_emails?: string[];
          subject?: string | null;
          sent_at?: string | null;
          is_calendar_response?: boolean;
          customer_side?: boolean;
          first_seen_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          internet_message_id?: string;
          graph_message_id?: string;
          mailbox?: string;
          conversation_id?: string | null;
          direction?: "inbound" | "outbound";
          from_email?: string | null;
          from_domain?: string | null;
          to_emails?: string[];
          cc_emails?: string[];
          subject?: string | null;
          sent_at?: string | null;
          is_calendar_response?: boolean;
          customer_side?: boolean;
          first_seen_at?: string;
        };
        Relationships: [];
      };
      app_users: {
        Row: {
          id: string;
          tenant_id: string;
          email: string;
          role: "cro" | "operator";
          created_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          email: string;
          role: "cro" | "operator";
          created_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          email?: string;
          role?: "cro" | "operator";
          created_at?: string;
        };
        Relationships: [];
      };
      microsoft_connections: {
        Row: {
          id: string;
          tenant_id: string;
          user_principal_name: string | null;
          microsoft_user_id: string | null;
          refresh_token_encrypted: string;
          scopes: string | null;
          connected_at: string;
          last_synced_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          user_principal_name?: string | null;
          microsoft_user_id?: string | null;
          refresh_token_encrypted: string;
          scopes?: string | null;
          connected_at?: string;
          last_synced_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          user_principal_name?: string | null;
          microsoft_user_id?: string | null;
          refresh_token_encrypted?: string;
          scopes?: string | null;
          connected_at?: string;
          last_synced_at?: string | null;
        };
        Relationships: [];
      };
      deal_cro_read: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          forecast_category: string | null;
          win_probability: number | null;
          expected_close: string | null;
          economic_buyer_engaged: string | null;
          biggest_unknown: string | null;
          notes: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          forecast_category?: string | null;
          win_probability?: number | null;
          expected_close?: string | null;
          economic_buyer_engaged?: string | null;
          biggest_unknown?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          forecast_category?: string | null;
          win_probability?: number | null;
          expected_close?: string | null;
          economic_buyer_engaged?: string | null;
          biggest_unknown?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      deal_crm_baseline: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          rolldog_opportunity_id: string | null;
          captured_at: string;
          payload: Json;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          rolldog_opportunity_id?: string | null;
          captured_at?: string;
          payload: Json;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          rolldog_opportunity_id?: string | null;
          captured_at?: string;
          payload?: Json;
        };
        Relationships: [];
      };
      sent_messages: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string | null;
          call_id: string | null;
          kind: string;
          to_email: string;
          subject: string;
          body_html: string;
          body_text: string;
          provider_id: string | null;
          sent_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id?: string | null;
          call_id?: string | null;
          kind: string;
          to_email: string;
          subject: string;
          body_html: string;
          body_text: string;
          provider_id?: string | null;
          sent_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string | null;
          call_id?: string | null;
          kind?: string;
          to_email?: string;
          subject?: string;
          body_html?: string;
          body_text?: string;
          provider_id?: string | null;
          sent_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string | null;
          call_id: string | null;
          title: string;
          detail: string | null;
          action_type: string | null;
          priority: string;
          deadline: string | null;
          rep_email: string | null;
          status: string;
          source: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id?: string | null;
          call_id?: string | null;
          title: string;
          detail?: string | null;
          action_type?: string | null;
          priority?: string;
          deadline?: string | null;
          rep_email?: string | null;
          status?: string;
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string | null;
          call_id?: string | null;
          title?: string;
          detail?: string | null;
          action_type?: string | null;
          priority?: string;
          deadline?: string | null;
          rep_email?: string | null;
          status?: string;
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
