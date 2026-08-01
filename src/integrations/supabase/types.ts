export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      plex_events: {
        Row: {
          action: string
          created_at: string
          detail: Json
          id: string
          member_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json
          id?: string
          member_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json
          id?: string
          member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plex_events_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "plex_members"
            referencedColumns: ["id"]
          },
        ]
      }
      plex_members: {
        Row: {
          access_type: string
          created_at: string
          device_client_ids: string[]
          device_ids: string[]
          device_names: string[]
          display_name: string
          email: string | null
          expires_at: string | null
          id: string
          invite_status: string | null
          last_seen_at: string | null
          library_ids: string[]
          link_account: string
          notes: string | null
          plex_user_id: string | null
          plex_username: string | null
          reseller_id: string | null
          shared_server_id: string | null
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          access_type: string
          created_at?: string
          device_client_ids?: string[]
          device_ids?: string[]
          device_names?: string[]
          display_name: string
          email?: string | null
          expires_at?: string | null
          id?: string
          invite_status?: string | null
          last_seen_at?: string | null
          library_ids?: string[]
          link_account?: string
          notes?: string | null
          plex_user_id?: string | null
          plex_username?: string | null
          reseller_id?: string | null
          shared_server_id?: string | null
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          access_type?: string
          created_at?: string
          device_client_ids?: string[]
          device_ids?: string[]
          device_names?: string[]
          display_name?: string
          email?: string | null
          expires_at?: string | null
          id?: string
          invite_status?: string | null
          last_seen_at?: string | null
          library_ids?: string[]
          link_account?: string
          notes?: string | null
          plex_user_id?: string | null
          plex_username?: string | null
          reseller_id?: string | null
          shared_server_id?: string | null
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plex_members_reseller_id_fkey"
            columns: ["reseller_id"]
            isOneToOne: false
            referencedRelation: "plex_resellers"
            referencedColumns: ["id"]
          },
        ]
      }
      plex_resellers: {
        Row: {
          auth_token: string | null
          created_at: string
          credits: number
          id: string
          name: string
          notes: string | null
          plex_email: string | null
          plex_username: string | null
          portal_code: string
          status: string
          updated_at: string
        }
        Insert: {
          auth_token?: string | null
          created_at?: string
          credits?: number
          id?: string
          name: string
          notes?: string | null
          plex_email?: string | null
          plex_username?: string | null
          portal_code: string
          status?: string
          updated_at?: string
        }
        Update: {
          auth_token?: string | null
          created_at?: string
          credits?: number
          id?: string
          name?: string
          notes?: string | null
          plex_email?: string | null
          plex_username?: string | null
          portal_code?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      plex_settings: {
        Row: {
          account_email: string | null
          account_username: string | null
          auth_token: string | null
          client_identifier: string
          default_library_ids: string[]
          enforce_key: string
          id: string
          last_enforce_result: Json | null
          last_enforced_at: string | null
          link_account_email: string | null
          link_account_username: string | null
          link_auth_token: string | null
          machine_identifier: string | null
          plex_pass: boolean
          remove_friend_on_expiry: boolean
          server_name: string | null
          server_url: string | null
          updated_at: string
        }
        Insert: {
          account_email?: string | null
          account_username?: string | null
          auth_token?: string | null
          client_identifier: string
          default_library_ids?: string[]
          enforce_key: string
          id?: string
          last_enforce_result?: Json | null
          last_enforced_at?: string | null
          link_account_email?: string | null
          link_account_username?: string | null
          link_auth_token?: string | null
          machine_identifier?: string | null
          plex_pass?: boolean
          remove_friend_on_expiry?: boolean
          server_name?: string | null
          server_url?: string | null
          updated_at?: string
        }
        Update: {
          account_email?: string | null
          account_username?: string | null
          auth_token?: string | null
          client_identifier?: string
          default_library_ids?: string[]
          enforce_key?: string
          id?: string
          last_enforce_result?: Json | null
          last_enforced_at?: string | null
          link_account_email?: string | null
          link_account_username?: string | null
          link_auth_token?: string | null
          machine_identifier?: string | null
          plex_pass?: boolean
          remove_friend_on_expiry?: boolean
          server_name?: string | null
          server_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      plex_spend_credits: {
        Args: { p_reseller_id: string; p_amount: number }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
