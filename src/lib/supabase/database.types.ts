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
      inventory_balances: {
        Row: {
          available: number
          awaiting_pickup: number
          company_id: string
          delivered: number
          linked: number
          organization_id: string
          pending_return: number
          prize_id: string
          reserved: number
          updated_at: string
          written_off: number
        }
        Insert: {
          available?: number
          awaiting_pickup?: number
          company_id: string
          delivered?: number
          linked?: number
          organization_id: string
          pending_return?: number
          prize_id: string
          reserved?: number
          updated_at?: string
          written_off?: number
        }
        Update: {
          available?: number
          awaiting_pickup?: number
          company_id?: string
          delivered?: number
          linked?: number
          organization_id?: string
          pending_return?: number
          prize_id?: string
          reserved?: number
          updated_at?: string
          written_off?: number
        }
        Relationships: [
          {
            foreignKeyName: "inventory_balances_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "inventory_balances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_balances_prize_company_fk"
            columns: ["prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          actor_id: string | null
          company_id: string
          created_at: string
          from_bucket: Database["public"]["Enums"]["inventory_bucket"] | null
          id: string
          idempotency_key: string | null
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note: string | null
          organization_id: string
          prize_id: string
          quantity: number
          to_bucket: Database["public"]["Enums"]["inventory_bucket"] | null
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          created_at?: string
          from_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          id?: string
          idempotency_key?: string | null
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note?: string | null
          organization_id: string
          prize_id: string
          quantity: number
          to_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          created_at?: string
          from_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          id?: string
          idempotency_key?: string | null
          movement_type?: Database["public"]["Enums"]["inventory_movement_type"]
          note?: string | null
          organization_id?: string
          prize_id?: string
          quantity?: number
          to_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "inventory_movements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_prize_company_fk"
            columns: ["prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id", "company_id"]
          },
        ]
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
      member_blocks: {
        Row: {
          company_id: string | null
          created_by: string | null
          ends_at: string | null
          id: string
          kind: Database["public"]["Enums"]["member_block_kind"]
          lift_reason: string | null
          lifted_at: string | null
          lifted_by: string | null
          member_id: string
          organization_id: string
          reason: string | null
          starts_at: string
        }
        Insert: {
          company_id?: string | null
          created_by?: string | null
          ends_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["member_block_kind"]
          lift_reason?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          member_id: string
          organization_id: string
          reason?: string | null
          starts_at?: string
        }
        Update: {
          company_id?: string | null
          created_by?: string | null
          ends_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["member_block_kind"]
          lift_reason?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          member_id?: string
          organization_id?: string
          reason?: string | null
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_blocks_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_blocks_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      member_company_links: {
        Row: {
          company_id: string
          linked_at: string
          linked_by: string | null
          member_id: string
          organization_id: string
        }
        Insert: {
          company_id: string
          linked_at?: string
          linked_by?: string | null
          member_id: string
          organization_id: string
        }
        Update: {
          company_id?: string
          linked_at?: string
          linked_by?: string | null
          member_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_links_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_links_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      member_consents: {
        Row: {
          company_id: string
          consent_type: Database["public"]["Enums"]["member_consent_type"]
          granted: boolean
          granted_at: string
          id: string
          member_id: string
          organization_id: string
          origin: string | null
          promotion_id: string | null
          recorded_by: string | null
        }
        Insert: {
          company_id: string
          consent_type: Database["public"]["Enums"]["member_consent_type"]
          granted: boolean
          granted_at?: string
          id?: string
          member_id: string
          organization_id: string
          origin?: string | null
          promotion_id?: string | null
          recorded_by?: string | null
        }
        Update: {
          company_id?: string
          consent_type?: Database["public"]["Enums"]["member_consent_type"]
          granted?: boolean
          granted_at?: string
          id?: string
          member_id?: string
          organization_id?: string
          origin?: string | null
          promotion_id?: string | null
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "member_consents_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_consents_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_consents_promotion_fk"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      member_notes: {
        Row: {
          body: string | null
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          member_id: string
          organization_id: string
        }
        Insert: {
          body?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id: string
          organization_id: string
        }
        Update: {
          body?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_notes_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_notes_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      members: {
        Row: {
          address_complement: string | null
          address_line: string | null
          address_number: string | null
          anonymized_at: string | null
          birth_date: string | null
          city: string | null
          cpf_hash: string | null
          cpf_last_digits: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          discovery_source: string | null
          email: string | null
          email_normalized: string | null
          first_contact_at: string | null
          first_contact_origin: string | null
          full_name: string | null
          id: string
          neighbourhood: string | null
          organization_id: string
          passport: string | null
          phone: string | null
          phone_normalized: string | null
          postal_code: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          anonymized_at?: string | null
          birth_date?: string | null
          city?: string | null
          cpf_hash?: string | null
          cpf_last_digits?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          discovery_source?: string | null
          email?: string | null
          email_normalized?: string | null
          first_contact_at?: string | null
          first_contact_origin?: string | null
          full_name?: string | null
          id?: string
          neighbourhood?: string | null
          organization_id: string
          passport?: string | null
          phone?: string | null
          phone_normalized?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          anonymized_at?: string | null
          birth_date?: string | null
          city?: string | null
          cpf_hash?: string | null
          cpf_last_digits?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          discovery_source?: string | null
          email?: string | null
          email_normalized?: string | null
          first_contact_at?: string | null
          first_contact_origin?: string | null
          full_name?: string | null
          id?: string
          neighbourhood?: string | null
          organization_id?: string
          passport?: string | null
          phone?: string | null
          phone_normalized?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
      prize_categories: {
        Row: {
          company_id: string
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prize_categories_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "prize_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      prizes: {
        Row: {
          allows_return_to_stock: boolean
          category_id: string | null
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          internal_code: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          allows_return_to_stock?: boolean
          category_id?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          internal_code?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          allows_return_to_stock?: boolean
          category_id?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          internal_code?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prizes_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "prize_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prizes_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "prizes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      promotion_question_options: {
        Row: {
          company_id: string
          created_at: string
          id: string
          is_correct: boolean
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          label: string
          organization_id: string
          position: number
          question_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          is_correct?: boolean
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          label: string
          organization_id: string
          position: number
          question_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          is_correct?: boolean
          kind?: Database["public"]["Enums"]["promotion_question_kind"]
          label?: string
          organization_id?: string
          position?: number
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_question_options_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_question_options_question_fk"
            columns: ["question_id", "kind", "company_id"]
            isOneToOne: false
            referencedRelation: "promotion_questions"
            referencedColumns: ["id", "kind", "company_id"]
          },
        ]
      }
      promotion_questions: {
        Row: {
          button_label: string | null
          company_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          menu_title: string | null
          organization_id: string
          position: number
          promotion_id: string
          prompt: string
          updated_at: string
        }
        Insert: {
          button_label?: string | null
          company_id: string
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          menu_title?: string | null
          organization_id: string
          position: number
          promotion_id: string
          prompt: string
          updated_at?: string
        }
        Update: {
          button_label?: string | null
          company_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["promotion_question_kind"]
          menu_title?: string | null
          organization_id?: string
          position?: number
          promotion_id?: string
          prompt?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_questions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_questions_promotion_fk"
            columns: ["promotion_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      promotions: {
        Row: {
          allow_multiple_entries: boolean
          art_url: string | null
          call_to_action: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          ends_at: string
          hashtag: string | null
          id: string
          min_hours_between_entries: number | null
          name: string
          no_button_label: string | null
          organization_id: string
          requested_fields: Database["public"]["Enums"]["promotion_requested_field"][]
          require_correct_answer: boolean
          site_integration_code: number | null
          starts_at: string
          updated_at: string
          use_art: boolean
          whatsapp_enabled: boolean
          yes_button_label: string | null
        }
        Insert: {
          allow_multiple_entries?: boolean
          art_url?: string | null
          call_to_action?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at: string
          hashtag?: string | null
          id?: string
          min_hours_between_entries?: number | null
          name: string
          no_button_label?: string | null
          organization_id: string
          requested_fields?: Database["public"]["Enums"]["promotion_requested_field"][]
          require_correct_answer?: boolean
          site_integration_code?: number | null
          starts_at: string
          updated_at?: string
          use_art?: boolean
          whatsapp_enabled?: boolean
          yes_button_label?: string | null
        }
        Update: {
          allow_multiple_entries?: boolean
          art_url?: string | null
          call_to_action?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at?: string
          hashtag?: string | null
          id?: string
          min_hours_between_entries?: number | null
          name?: string
          no_button_label?: string | null
          organization_id?: string
          requested_fields?: Database["public"]["Enums"]["promotion_requested_field"][]
          require_correct_answer?: boolean
          site_integration_code?: number | null
          starts_at?: string
          updated_at?: string
          use_art?: boolean
          whatsapp_enabled?: boolean
          yes_button_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "promotions_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "promotions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      add_member_note: {
        Args: { p_body: string; p_company_id: string; p_member_id: string }
        Returns: string
      }
      adjust_stock: {
        Args: {
          p_company_id: string
          p_counted: number
          p_idempotency_key?: string
          p_note: string
          p_prize_id: string
        }
        Returns: string
      }
      anonymize_member: {
        Args: {
          p_member_id: string
          p_reason: Database["public"]["Enums"]["member_erasure_reason"]
        }
        Returns: undefined
      }
      apply_inventory_movement: {
        Args: {
          p_company_id: string
          p_from: Database["public"]["Enums"]["inventory_bucket"]
          p_idempotency_key: string
          p_note: string
          p_prize_id: string
          p_quantity: number
          p_to: Database["public"]["Enums"]["inventory_bucket"]
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
        }
        Returns: string
      }
      archive_member: { Args: { p_member_id: string }; Returns: undefined }
      archive_prize: { Args: { p_prize_id: string }; Returns: undefined }
      archive_promotion: {
        Args: { p_promotion_id: string }
        Returns: undefined
      }
      assign_company_role: {
        Args: { p_company_id: string; p_role_id: string; p_user_id: string }
        Returns: string
      }
      block_member: {
        Args: {
          p_company_id?: string
          p_ends_at?: string
          p_kind: Database["public"]["Enums"]["member_block_kind"]
          p_member_id: string
          p_reason: string
        }
        Returns: string
      }
      cancel_promotion: {
        Args: { p_promotion_id: string; p_reason: string }
        Returns: undefined
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
      create_member: {
        Args: {
          p_address_complement?: string
          p_address_line?: string
          p_address_number?: string
          p_birth_date?: string
          p_city?: string
          p_company_id: string
          p_cpf_hash?: string
          p_cpf_last_digits?: string
          p_discovery_source?: string
          p_email?: string
          p_first_contact_at?: string
          p_first_contact_origin?: string
          p_full_name: string
          p_neighbourhood?: string
          p_passport?: string
          p_phone?: string
          p_postal_code?: string
          p_state?: string
        }
        Returns: string
      }
      create_prize: {
        Args: {
          p_allows_return_to_stock?: boolean
          p_category_id?: string
          p_company_id: string
          p_description?: string
          p_internal_code?: string
          p_name: string
        }
        Returns: string
      }
      create_prize_category: {
        Args: { p_company_id: string; p_name: string }
        Returns: string
      }
      create_promotion: {
        Args: {
          p_allow_multiple_entries?: boolean
          p_art_url?: string
          p_call_to_action?: string
          p_company_id: string
          p_ends_at: string
          p_hashtag?: string
          p_min_hours_between_entries?: number
          p_name: string
          p_no_button_label?: string
          p_requested_fields?: Database["public"]["Enums"]["promotion_requested_field"][]
          p_require_correct_answer?: boolean
          p_site_integration_code?: number
          p_starts_at: string
          p_use_art?: boolean
          p_whatsapp_enabled?: boolean
          p_yes_button_label?: string
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
      ensure_inventory_balance_row: {
        Args: { p_company_id: string; p_org: string; p_prize_id: string }
        Returns: undefined
      }
      find_member_by_identifier: {
        Args: {
          p_cpf_hash?: string
          p_email?: string
          p_organization_id: string
          p_passport?: string
          p_phone?: string
        }
        Returns: Json
      }
      has_company_access: { Args: { p_company_id: string }; Returns: boolean }
      has_no_duplicates: { Args: { p_values: unknown }; Returns: boolean }
      has_org_permission: {
        Args: { p_organization_id: string; p_permission: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_company_id: string; p_permission: string }
        Returns: boolean
      }
      is_company_member: { Args: { p_company_id: string }; Returns: boolean }
      is_member_blocked: {
        Args: { p_company_id: string; p_member_id: string }
        Returns: boolean
      }
      is_org_member: { Args: { p_organization_id: string }; Returns: boolean }
      is_owner: { Args: { p_organization_id: string }; Returns: boolean }
      is_owner_of_company: { Args: { p_company_id: string }; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      lift_member_block: {
        Args: { p_block_id: string; p_reason: string }
        Returns: undefined
      }
      link_member_to_company: {
        Args: { p_company_id: string; p_member_id: string }
        Returns: undefined
      }
      list_manageable_companies: {
        Args: { p_organization_id: string; p_permission: string }
        Returns: {
          id: string
          name: string
          status: Database["public"]["Enums"]["company_status"]
        }[]
      }
      member_linked_to_company: {
        Args: { p_company_id: string; p_member_id: string }
        Returns: boolean
      }
      member_reachable: {
        Args: {
          p_member_id: string
          p_organization_id: string
          p_permission: string
        }
        Returns: boolean
      }
      members_blocked_bulk: {
        Args: { p_company_id: string; p_member_ids: string[] }
        Returns: {
          blocked: boolean
          member_id: string
        }[]
      }
      normalize_email: { Args: { p_email: string }; Returns: string }
      normalize_phone: { Args: { p_phone: string }; Returns: string }
      promotion_write_error: {
        Args: { p_hashtag: string; p_site_code: number; p_sqlstate: string }
        Returns: undefined
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
      reconcile_inventory: {
        Args: { p_company_id: string }
        Returns: {
          bucket: string
          computed: number
          prize_id: string
          prize_name: string
          stored: number
        }[]
      }
      record_member_consent: {
        Args: {
          p_company_id: string
          p_consent_type: Database["public"]["Enums"]["member_consent_type"]
          p_granted: boolean
          p_member_id: string
          p_origin?: string
          p_promotion_id?: string
        }
        Returns: string
      }
      record_stock_entry: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_note?: string
          p_prize_id: string
          p_quantity: number
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
        }
        Returns: string
      }
      record_stock_exit: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_note: string
          p_prize_id: string
          p_quantity: number
        }
        Returns: string
      }
      release_reservation: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_note: string
          p_prize_id: string
          p_quantity: number
        }
        Returns: string
      }
      remove_company_access: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_member: { Args: { p_membership_id: string }; Returns: undefined }
      remove_promotion_question: {
        Args: { p_question_id: string }
        Returns: undefined
      }
      reserve_stock: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_note: string
          p_prize_id: string
          p_quantity: number
        }
        Returns: string
      }
      reset_provisional_password: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      save_promotion_question: {
        Args: {
          p_button_label?: string
          p_kind: Database["public"]["Enums"]["promotion_question_kind"]
          p_menu_title?: string
          p_options?: Json
          p_promotion_id: string
          p_prompt: string
          p_question_id?: string
        }
        Returns: string
      }
      shares_organization_with: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      suspend_company: {
        Args: { p_company_id: string; p_reason: string }
        Returns: undefined
      }
      update_member: {
        Args: {
          p_address_complement?: string
          p_address_line?: string
          p_address_number?: string
          p_birth_date?: string
          p_city?: string
          p_cpf_hash?: string
          p_cpf_last_digits?: string
          p_discovery_source?: string
          p_email?: string
          p_full_name: string
          p_member_id: string
          p_neighbourhood?: string
          p_passport?: string
          p_phone?: string
          p_postal_code?: string
          p_state?: string
        }
        Returns: undefined
      }
      update_prize: {
        Args: {
          p_allows_return_to_stock?: boolean
          p_category_id?: string
          p_description?: string
          p_internal_code?: string
          p_name: string
          p_prize_id: string
        }
        Returns: undefined
      }
      update_promotion: {
        Args: {
          p_allow_multiple_entries?: boolean
          p_art_url?: string
          p_call_to_action?: string
          p_ends_at: string
          p_hashtag?: string
          p_min_hours_between_entries?: number
          p_name: string
          p_no_button_label?: string
          p_promotion_id: string
          p_requested_fields?: Database["public"]["Enums"]["promotion_requested_field"][]
          p_require_correct_answer?: boolean
          p_site_integration_code?: number
          p_starts_at: string
          p_use_art?: boolean
          p_whatsapp_enabled?: boolean
          p_yes_button_label?: string
        }
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
      inventory_bucket:
        | "available"
        | "reserved"
        | "linked"
        | "awaiting_pickup"
        | "pending_return"
        | "delivered"
        | "written_off"
      inventory_movement_type:
        | "INITIAL_ENTRY"
        | "PURCHASE_ENTRY"
        | "MANUAL_ENTRY"
        | "MANUAL_EXIT"
        | "ADJUSTMENT_POSITIVE"
        | "ADJUSTMENT_NEGATIVE"
        | "RESERVATION"
        | "RESERVATION_RELEASE"
        | "PROMOTION_LINK"
        | "PROMOTION_UNLINK"
        | "DRAW"
        | "DRAW_CANCEL"
        | "DELIVERY"
        | "RETURN_PENDING"
        | "RETURN_TO_STOCK"
        | "WRITE_OFF"
      invitation_status: "pending" | "accepted" | "revoked"
      member_block_kind: "draw_ban" | "suspension"
      member_consent_type: "rules" | "image_use" | "sponsor_communication"
      member_erasure_reason:
        | "subject_request"
        | "court_order"
        | "internal_policy"
      org_role: "owner" | "member"
      permission_scope: "organization" | "company"
      promotion_question_kind: "QUIZ" | "MULTIPLE_CHOICE" | "ESSAY"
      promotion_requested_field:
        | "full_name"
        | "address"
        | "city"
        | "neighbourhood"
        | "age"
        | "cpf"
        | "passport"
        | "discovery_source"
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
      inventory_bucket: [
        "available",
        "reserved",
        "linked",
        "awaiting_pickup",
        "pending_return",
        "delivered",
        "written_off",
      ],
      inventory_movement_type: [
        "INITIAL_ENTRY",
        "PURCHASE_ENTRY",
        "MANUAL_ENTRY",
        "MANUAL_EXIT",
        "ADJUSTMENT_POSITIVE",
        "ADJUSTMENT_NEGATIVE",
        "RESERVATION",
        "RESERVATION_RELEASE",
        "PROMOTION_LINK",
        "PROMOTION_UNLINK",
        "DRAW",
        "DRAW_CANCEL",
        "DELIVERY",
        "RETURN_PENDING",
        "RETURN_TO_STOCK",
        "WRITE_OFF",
      ],
      invitation_status: ["pending", "accepted", "revoked"],
      member_block_kind: ["draw_ban", "suspension"],
      member_consent_type: ["rules", "image_use", "sponsor_communication"],
      member_erasure_reason: [
        "subject_request",
        "court_order",
        "internal_policy",
      ],
      org_role: ["owner", "member"],
      permission_scope: ["organization", "company"],
      promotion_question_kind: ["QUIZ", "MULTIPLE_CHOICE", "ESSAY"],
      promotion_requested_field: [
        "full_name",
        "address",
        "city",
        "neighbourhood",
        "age",
        "cpf",
        "passport",
        "discovery_source",
      ],
    },
  },
} as const

