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
          dealripe_last_writeback_at: string | null;
          rep_email: string | null;
          rolldog_opportunity_id: string | null;
          rolldog_link_confidence: string | null;
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
          dealripe_last_writeback_at?: string | null;
          rep_email?: string | null;
          rolldog_opportunity_id?: string | null;
          rolldog_link_confidence?: string | null;
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
          dealripe_last_writeback_at?: string | null;
          rep_email?: string | null;
          rolldog_opportunity_id?: string | null;
          rolldog_link_confidence?: string | null;
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
          recall_bot_id: string | null;
          ingest_error: string | null;
          briefing_sent_at: string | null;
          scheduled_start: string | null;
          outcome: string | null;
          meeting_type: string | null;
          title: string | null;
          call_subtype: string | null;
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
          recall_bot_id?: string | null;
          ingest_error?: string | null;
          briefing_sent_at?: string | null;
          scheduled_start?: string | null;
          outcome?: string | null;
          meeting_type?: string | null;
          title?: string | null;
          call_subtype?: string | null;
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
          recall_bot_id?: string | null;
          ingest_error?: string | null;
          briefing_sent_at?: string | null;
          scheduled_start?: string | null;
          outcome?: string | null;
          meeting_type?: string | null;
          title?: string | null;
          call_subtype?: string | null;
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
      prescribed_actions: {
        Row: {
          id: string;
          tenant_id: string;
          deal_id: string;
          call_external_id: string | null;
          framework_field_key: string;
          prescription: string;
          created_at: string;
          asked_on_next_call: boolean | null;
          outcome_label: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          deal_id: string;
          call_external_id?: string | null;
          framework_field_key: string;
          prescription: string;
          created_at?: string;
          asked_on_next_call?: boolean | null;
          outcome_label?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          deal_id?: string;
          call_external_id?: string | null;
          framework_field_key?: string;
          prescription?: string;
          created_at?: string;
          asked_on_next_call?: boolean | null;
          outcome_label?: string | null;
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
