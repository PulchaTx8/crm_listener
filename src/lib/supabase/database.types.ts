export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          company_id: string | null
          created_at: string
          detail: Json
          id: number
          organization_id: string | null
          succeeded: boolean
          target_id: string | null
          target_table: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          company_id?: string | null
          created_at?: string
          detail?: Json
          id?: number
          organization_id?: string | null
          succeeded?: boolean
          target_id?: string | null
          target_table?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          company_id?: string | null
          created_at?: string
          detail?: Json
          id?: number
          organization_id?: string | null
          succeeded?: boolean
          target_id?: string | null
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          organization_id: string
          provisioned_at: string
          provisioned_by: string | null
          status: Database["public"]["Enums"]["company_status"]
          suspended_at: string | null
          suspension_reason: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          organization_id: string
          provisioned_at?: string
          provisioned_by?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          organization_id?: string
          provisioned_at?: string
          provisioned_by?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "companies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      company_memberships: {
        Row: {
          company_id: string
          created_at: string
          deleted_at: string | null
          id: string
          organization_id: string
          role_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          organization_id: string
          role_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          organization_id?: string
          role_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_memberships_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_memberships_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "company_memberships_role_org_fk"
            columns: ["role_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      contact_requests: {
        Row: {
          company_name: string | null
          created_at: string
          email: string
          id: string
          ip_hash: string | null
          message: string | null
          name: string
          phone: string | null
          status: Database["public"]["Enums"]["contact_request_status"]
          updated_at: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          email: string
          id?: string
          ip_hash?: string | null
          message?: string | null
          name: string
          phone?: string | null
          status?: Database["public"]["Enums"]["contact_request_status"]
          updated_at?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string
          email?: string
          id?: string
          ip_hash?: string | null
          message?: string | null
          name?: string
          phone?: string | null
          status?: Database["public"]["Enums"]["contact_request_status"]
          updated_at?: string
        }
        Relationships: []
      }
      invitation_companies: {
        Row: {
          company_id: string
          invitation_id: string
        }
        Insert: {
          company_id: string
          invitation_id: string
        }
        Update: {
          company_id?: string
          invitation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitation_companies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_companies_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          is_owner: boolean
          organization_id: string
          revoked_at: string | null
          role_id: string | null
          status: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          is_owner?: boolean
          organization_id: string
          revoked_at?: string | null
          role_id?: string | null
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          is_owner?: boolean
          organization_id?: string
          revoked_at?: string | null
          role_id?: string | null
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_role_org_fk"
            columns: ["role_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["org_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          organization_id: string
          role: Database["public"]["Enums"]["org_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      permissions: {
        Row: {
          code: string
          created_at: string
          description: string
          display_order: number
          introduced_by_block: string
          label: string
          module: string
          scope: Database["public"]["Enums"]["permission_scope"]
        }
        Insert: {
          code: string
          created_at?: string
          description: string
          display_order?: number
          introduced_by_block: string
          label: string
          module: string
          scope: Database["public"]["Enums"]["permission_scope"]
        }
        Update: {
          code?: string
          created_at?: string
          description?: string
          display_order?: number
          introduced_by_block?: string
          label?: string
          module?: string
          scope?: Database["public"]["Enums"]["permission_scope"]
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string
          full_name: string | null
          id: string
          must_change_password: boolean
          provisional_expires_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email: string
          full_name?: string | null
          id: string
          must_change_password?: boolean
          provisional_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          must_change_password?: boolean
          provisional_expires_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_counters: {
        Row: {
          count: number
          key: string
          reset_at: string
        }
        Insert: {
          count?: number
          key: string
          reset_at: string
        }
        Update: {
          count?: number
          key?: string
          reset_at?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          permission_code: string
          role_id: string
        }
        Insert: {
          permission_code: string
          role_id: string
        }
        Update: {
          permission_code?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: {
        Args: { p_full_name?: string; p_token_hash: string; p_user_id: string }
        Returns: Json
      }
      add_company: {
        Args: { p_name: string; p_organization_id: string; p_timezone?: string }
        Returns: string
      }
      assign_company_role: {
        Args: { p_company_id: string; p_role_id: string; p_user_id: string }
        Returns: string
      }
      change_org_role: {
        Args: {
          p_membership_id: string
          p_new_role: Database["public"]["Enums"]["org_role"]
        }
        Returns: undefined
      }
      complete_password_change: { Args: never; Returns: undefined }
      create_invitation: {
        Args: {
          p_company_ids: string[]
          p_email: string
          p_is_owner: boolean
          p_organization_id: string
          p_role_id: string
          p_token_hash: string
          p_ttl_days?: number
        }
        Returns: string
      }
      create_role: {
        Args: {
          p_description?: string
          p_name: string
          p_organization_id: string
          p_permission_codes?: string[]
        }
        Returns: string
      }
      delete_role: { Args: { p_role_id: string }; Returns: undefined }
      has_company_access: { Args: { p_company_id: string }; Returns: boolean }
      has_org_permission: {
        Args: { p_organization_id: string; p_permission: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_company_id: string; p_permission: string }
        Returns: boolean
      }
      is_company_member: { Args: { p_company_id: string }; Returns: boolean }
      is_org_member: { Args: { p_organization_id: string }; Returns: boolean }
      is_owner: { Args: { p_organization_id: string }; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      list_manageable_companies: {
        Args: { p_organization_id: string }
        Returns: {
          id: string
          name: string
          status: Database["public"]["Enums"]["company_status"]
        }[]
      }
      provision_customer: {
        Args: {
          p_company_name: string
          p_organization_name: string
          p_timezone?: string
          p_user_id: string
        }
        Returns: Json
      }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          remaining: number
          reset_at: string
        }[]
      }
      reactivate_company: { Args: { p_company_id: string }; Returns: undefined }
      remove_company_access: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_member: { Args: { p_membership_id: string }; Returns: undefined }
      reset_provisional_password: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      shares_organization_with: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      suspend_company: {
        Args: { p_company_id: string; p_reason: string }
        Returns: undefined
      }
      update_role: {
        Args: {
          p_description?: string
          p_name: string
          p_permission_codes?: string[]
          p_role_id: string
        }
        Returns: undefined
      }
      validate_invitation: { Args: { p_token_hash: string }; Returns: Json }
    }
    Enums: {
      company_status: "active" | "suspended"
      contact_request_status: "new" | "contacted" | "converted" | "discarded"
      invitation_status: "pending" | "accepted" | "revoked"
      org_role: "owner" | "member"
      permission_scope: "organization" | "company"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      company_status: ["active", "suspended"],
      contact_request_status: ["new", "contacted", "converted", "discarded"],
      invitation_status: ["pending", "accepted", "revoked"],
      org_role: ["owner", "member"],
      permission_scope: ["organization", "company"],
    },
  },
} as const

