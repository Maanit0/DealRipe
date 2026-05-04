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
          source: "gong" | "manual_paste" | null;
          transcript_id: string | null;
          has_been_extracted: boolean;
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
          source?: "gong" | "manual_paste" | null;
          transcript_id?: string | null;
          has_been_extracted?: boolean;
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
          source?: "gong" | "manual_paste" | null;
          transcript_id?: string | null;
          has_been_extracted?: boolean;
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
          scotsman_field_id: string;
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
          scotsman_field_id: string;
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
          scotsman_field_id?: string;
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
