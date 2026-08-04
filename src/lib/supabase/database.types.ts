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
      artists: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "artists_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "artists_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
      draw_entries: {
        Row: {
          company_id: string
          draw_id: string
          member_id: string
          participation_id: string
          position: number
        }
        Insert: {
          company_id: string
          draw_id: string
          member_id: string
          participation_id: string
          position: number
        }
        Update: {
          company_id?: string
          draw_id?: string
          member_id?: string
          participation_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "draw_entries_draw_fk"
            columns: ["draw_id", "company_id"]
            isOneToOne: false
            referencedRelation: "draws"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "draw_entries_member_link_fk"
            columns: ["member_id", "company_id"]
            isOneToOne: false
            referencedRelation: "member_company_links"
            referencedColumns: ["member_id", "company_id"]
          },
          {
            foreignKeyName: "draw_entries_participation_fk"
            columns: ["participation_id", "company_id"]
            isOneToOne: false
            referencedRelation: "participations"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      draws: {
        Row: {
          algorithm_version: number
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          company_id: string
          drawn_at: string
          drawn_by: string | null
          entry_count: number
          id: string
          included_wrong_answers: boolean
          offered_count: number
          organization_id: string
          promotion_id: string
          seed: string
          status: Database["public"]["Enums"]["draw_status"]
        }
        Insert: {
          algorithm_version: number
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id: string
          drawn_at?: string
          drawn_by?: string | null
          entry_count: number
          id?: string
          included_wrong_answers?: boolean
          offered_count: number
          organization_id: string
          promotion_id: string
          seed: string
          status?: Database["public"]["Enums"]["draw_status"]
        }
        Update: {
          algorithm_version?: number
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id?: string
          drawn_at?: string
          drawn_by?: string | null
          entry_count?: number
          id?: string
          included_wrong_answers?: boolean
          offered_count?: number
          organization_id?: string
          promotion_id?: string
          seed?: string
          status?: Database["public"]["Enums"]["draw_status"]
        }
        Relationships: [
          {
            foreignKeyName: "draws_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "draws_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draws_promotion_fk"
            columns: ["promotion_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      integrations: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          display_phone_number: string | null
          enabled: boolean
          id: string
          organization_id: string
          phone_number_id: string
          provider: Database["public"]["Enums"]["integration_provider"]
          updated_at: string
          waba_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          display_phone_number?: string | null
          enabled?: boolean
          id?: string
          organization_id: string
          phone_number_id: string
          provider: Database["public"]["Enums"]["integration_provider"]
          updated_at?: string
          waba_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          display_phone_number?: string | null
          enabled?: boolean
          id?: string
          organization_id?: string
          phone_number_id?: string
          provider?: Database["public"]["Enums"]["integration_provider"]
          updated_at?: string
          waba_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integrations_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
          promotion_prize_id: string | null
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
          promotion_prize_id?: string | null
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
          promotion_prize_id?: string | null
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
          {
            foreignKeyName: "inventory_movements_promotion_prize_fk"
            columns: ["promotion_prize_id", "prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotion_prizes"
            referencedColumns: ["id", "prize_id", "company_id"]
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
      member_field_confirmations: {
        Row: {
          confirmed_at: string
          field: Database["public"]["Enums"]["promotion_requested_field"]
          member_id: string
          organization_id: string
        }
        Insert: {
          confirmed_at?: string
          field: Database["public"]["Enums"]["promotion_requested_field"]
          member_id: string
          organization_id: string
        }
        Update: {
          confirmed_at?: string
          field?: Database["public"]["Enums"]["promotion_requested_field"]
          member_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_field_confirmations_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "member_field_confirmations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      music_genres: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "music_genres_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "music_genres_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      music_requests: {
        Row: {
          channel: Database["public"]["Enums"]["music_request_channel"]
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          member_id: string
          organization_id: string
          requested_at: string
          show_id: string | null
          song_id: string
          updated_at: string
        }
        Insert: {
          channel?: Database["public"]["Enums"]["music_request_channel"]
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          member_id: string
          organization_id: string
          requested_at?: string
          show_id?: string | null
          song_id: string
          updated_at?: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["music_request_channel"]
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          member_id?: string
          organization_id?: string
          requested_at?: string
          show_id?: string | null
          song_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "music_requests_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "music_requests_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "music_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "music_requests_show_company_fk"
            columns: ["show_id", "company_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "music_requests_song_company_fk"
            columns: ["song_id", "company_id"]
            isOneToOne: false
            referencedRelation: "songs"
            referencedColumns: ["id", "company_id"]
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
      outbox_messages: {
        Row: {
          attempts: number
          body: string
          claimed_at: string | null
          company_id: string
          created_at: string
          dedupe_key: string
          external_id: string | null
          id: string
          integration_id: string
          interactive: Json | null
          last_error: string | null
          next_attempt_at: string
          organization_id: string
          provider: Database["public"]["Enums"]["integration_provider"]
          pruned_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["outbox_status"]
          to_phone: string | null
        }
        Insert: {
          attempts?: number
          body: string
          claimed_at?: string | null
          company_id: string
          created_at?: string
          dedupe_key: string
          external_id?: string | null
          id?: string
          integration_id: string
          interactive?: Json | null
          last_error?: string | null
          next_attempt_at?: string
          organization_id: string
          provider: Database["public"]["Enums"]["integration_provider"]
          pruned_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["outbox_status"]
          to_phone?: string | null
        }
        Update: {
          attempts?: number
          body?: string
          claimed_at?: string | null
          company_id?: string
          created_at?: string
          dedupe_key?: string
          external_id?: string | null
          id?: string
          integration_id?: string
          interactive?: Json | null
          last_error?: string | null
          next_attempt_at?: string
          organization_id?: string
          provider?: Database["public"]["Enums"]["integration_provider"]
          pruned_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["outbox_status"]
          to_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outbox_messages_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "outbox_messages_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbox_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      participation_answers: {
        Row: {
          answer_text: string | null
          company_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          option_id: string | null
          organization_id: string
          participation_id: string
          promotion_id: string
          question_id: string
        }
        Insert: {
          answer_text?: string | null
          company_id: string
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["promotion_question_kind"]
          option_id?: string | null
          organization_id: string
          participation_id: string
          promotion_id: string
          question_id: string
        }
        Update: {
          answer_text?: string | null
          company_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["promotion_question_kind"]
          option_id?: string | null
          organization_id?: string
          participation_id?: string
          promotion_id?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "participation_answers_option_fk"
            columns: ["option_id", "question_id"]
            isOneToOne: false
            referencedRelation: "promotion_question_options"
            referencedColumns: ["id", "question_id"]
          },
          {
            foreignKeyName: "participation_answers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participation_answers_participation_fk"
            columns: ["participation_id", "promotion_id"]
            isOneToOne: false
            referencedRelation: "participations"
            referencedColumns: ["id", "promotion_id"]
          },
          {
            foreignKeyName: "participation_answers_question_fk"
            columns: ["question_id", "promotion_id", "kind", "company_id"]
            isOneToOne: false
            referencedRelation: "promotion_questions"
            referencedColumns: ["id", "promotion_id", "kind", "company_id"]
          },
        ]
      }
      participations: {
        Row: {
          allows_multiple: boolean
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          member_id: string
          organization_id: string
          participated_at: string
          promotion_id: string
          source: Database["public"]["Enums"]["participation_source"]
          status: Database["public"]["Enums"]["participation_status"]
        }
        Insert: {
          allows_multiple: boolean
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id: string
          organization_id: string
          participated_at: string
          promotion_id: string
          source: Database["public"]["Enums"]["participation_source"]
          status: Database["public"]["Enums"]["participation_status"]
        }
        Update: {
          allows_multiple?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          member_id?: string
          organization_id?: string
          participated_at?: string
          promotion_id?: string
          source?: Database["public"]["Enums"]["participation_source"]
          status?: Database["public"]["Enums"]["participation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "participations_allows_multiple_fk"
            columns: ["promotion_id", "allows_multiple"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id", "allow_multiple_entries"]
          },
          {
            foreignKeyName: "participations_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "participations_member_link_fk"
            columns: ["member_id", "company_id"]
            isOneToOne: false
            referencedRelation: "member_company_links"
            referencedColumns: ["member_id", "company_id"]
          },
          {
            foreignKeyName: "participations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participations_promotion_fk"
            columns: ["promotion_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id", "company_id"]
          },
        ]
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
          default_pickup_deadline_days: number | null
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
          default_pickup_deadline_days?: number | null
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
          default_pickup_deadline_days?: number | null
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
      promotion_prize_balances: {
        Row: {
          company_id: string
          drawn: number
          linked: number
          organization_id: string
          prize_id: string
          promotion_prize_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          drawn?: number
          linked?: number
          organization_id: string
          prize_id: string
          promotion_prize_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          drawn?: number
          linked?: number
          organization_id?: string
          prize_id?: string
          promotion_prize_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_prize_balances_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "promotion_prize_balances_link_fk"
            columns: ["promotion_prize_id", "prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotion_prizes"
            referencedColumns: ["id", "prize_id", "company_id"]
          },
          {
            foreignKeyName: "promotion_prize_balances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      promotion_prizes: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          organization_id: string
          prize_id: string
          promotion_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          organization_id: string
          prize_id: string
          promotion_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          organization_id?: string
          prize_id?: string
          promotion_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_prizes_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "promotion_prizes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_prizes_prize_fk"
            columns: ["prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "promotion_prizes_promotion_fk"
            columns: ["promotion_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id", "company_id"]
          },
        ]
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
      promotion_refusals: {
        Row: {
          company_id: string
          id: string
          member_id: string
          organization_id: string
          promotion_id: string
          refused_at: string
          source: Database["public"]["Enums"]["participation_source"]
        }
        Insert: {
          company_id: string
          id?: string
          member_id: string
          organization_id: string
          promotion_id: string
          refused_at?: string
          source: Database["public"]["Enums"]["participation_source"]
        }
        Update: {
          company_id?: string
          id?: string
          member_id?: string
          organization_id?: string
          promotion_id?: string
          refused_at?: string
          source?: Database["public"]["Enums"]["participation_source"]
        }
        Relationships: [
          {
            foreignKeyName: "promotion_refusals_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "promotion_refusals_member_org_fk"
            columns: ["member_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "promotion_refusals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_refusals_promotion_fk"
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
          data_validity_months: number | null
          deleted_at: string | null
          deleted_by: string | null
          ends_at: string
          hashtag: string | null
          id: string
          max_entries_per_member: number | null
          min_hours_between_entries: number | null
          name: string
          no_button_label: string | null
          organization_id: string
          pickup_deadline_days: number | null
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
          data_validity_months?: number | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at: string
          hashtag?: string | null
          id?: string
          max_entries_per_member?: number | null
          min_hours_between_entries?: number | null
          name: string
          no_button_label?: string | null
          organization_id: string
          pickup_deadline_days?: number | null
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
          data_validity_months?: number | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at?: string
          hashtag?: string | null
          id?: string
          max_entries_per_member?: number | null
          min_hours_between_entries?: number | null
          name?: string
          no_button_label?: string | null
          organization_id?: string
          pickup_deadline_days?: number | null
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
      record_labels: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "record_labels_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "record_labels_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      shows: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shows_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "shows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      songs: {
        Row: {
          artist_id: string
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          duration_seconds: number | null
          genre_id: string | null
          id: string
          internal_code: string | null
          label_id: string | null
          legacy_id: string | null
          nationality: Database["public"]["Enums"]["music_nationality"] | null
          organization_id: string
          title: string
          updated_at: string
          vocal: Database["public"]["Enums"]["music_vocal"] | null
        }
        Insert: {
          artist_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          duration_seconds?: number | null
          genre_id?: string | null
          id?: string
          internal_code?: string | null
          label_id?: string | null
          legacy_id?: string | null
          nationality?: Database["public"]["Enums"]["music_nationality"] | null
          organization_id: string
          title: string
          updated_at?: string
          vocal?: Database["public"]["Enums"]["music_vocal"] | null
        }
        Update: {
          artist_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          duration_seconds?: number | null
          genre_id?: string | null
          id?: string
          internal_code?: string | null
          label_id?: string | null
          legacy_id?: string | null
          nationality?: Database["public"]["Enums"]["music_nationality"] | null
          organization_id?: string
          title?: string
          updated_at?: string
          vocal?: Database["public"]["Enums"]["music_vocal"] | null
        }
        Relationships: [
          {
            foreignKeyName: "songs_artist_company_fk"
            columns: ["artist_id", "company_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "songs_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "songs_genre_company_fk"
            columns: ["genre_id", "company_id"]
            isOneToOne: false
            referencedRelation: "music_genres"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "songs_label_company_fk"
            columns: ["label_id", "company_id"]
            isOneToOne: false
            referencedRelation: "record_labels"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "songs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_erasure_queue: {
        Row: {
          attempts: number
          bucket: string
          enqueued_at: string
          id: string
          last_error: string | null
          path: string
          processed_at: string | null
        }
        Insert: {
          attempts?: number
          bucket: string
          enqueued_at?: string
          id?: string
          last_error?: string | null
          path: string
          processed_at?: string | null
        }
        Update: {
          attempts?: number
          bucket?: string
          enqueued_at?: string
          id?: string
          last_error?: string | null
          path?: string
          processed_at?: string | null
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          attempts: number
          claimed_at: string | null
          company_id: string | null
          external_id: string
          id: string
          integration_id: string | null
          last_error: string | null
          next_attempt_at: string | null
          organization_id: string | null
          outcome: string | null
          payload: Json | null
          processed_at: string | null
          provider: Database["public"]["Enums"]["integration_provider"]
          received_at: string
          status: Database["public"]["Enums"]["webhook_event_status"]
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          company_id?: string | null
          external_id: string
          id?: string
          integration_id?: string | null
          last_error?: string | null
          next_attempt_at?: string | null
          organization_id?: string | null
          outcome?: string | null
          payload?: Json | null
          processed_at?: string | null
          provider: Database["public"]["Enums"]["integration_provider"]
          received_at?: string
          status?: Database["public"]["Enums"]["webhook_event_status"]
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          company_id?: string | null
          external_id?: string
          id?: string
          integration_id?: string | null
          last_error?: string | null
          next_attempt_at?: string | null
          organization_id?: string | null
          outcome?: string | null
          payload?: Json | null
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["integration_provider"]
          received_at?: string
          status?: Database["public"]["Enums"]["webhook_event_status"]
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "webhook_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversation_leases: {
        Row: {
          claimed_at: string
          integration_id: string
          phone: string
          token: string
        }
        Insert: {
          claimed_at?: string
          integration_id: string
          phone: string
          token?: string
        }
        Update: {
          claimed_at?: string
          integration_id?: string
          phone?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_conversation_leases_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversations: {
        Row: {
          created_at: string
          expires_at: string
          integration_id: string
          phone: string
          state: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          integration_id: string
          phone: string
          state: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          integration_id?: string
          phone?: string
          state?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_conversations_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      winner_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          company_id: string
          from_status: Database["public"]["Enums"]["winner_status"]
          id: string
          reason: string | null
          to_status: Database["public"]["Enums"]["winner_status"]
          winner_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          company_id: string
          from_status: Database["public"]["Enums"]["winner_status"]
          id?: string
          reason?: string | null
          to_status: Database["public"]["Enums"]["winner_status"]
          winner_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          from_status?: Database["public"]["Enums"]["winner_status"]
          id?: string
          reason?: string | null
          to_status?: Database["public"]["Enums"]["winner_status"]
          winner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "winner_status_history_winner_fk"
            columns: ["winner_id", "company_id"]
            isOneToOne: false
            referencedRelation: "winners"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      winners: {
        Row: {
          awarded_rank: number
          company_id: string
          created_at: string
          deadline_at: string | null
          draw_id: string
          id: string
          member_id: string
          participation_id: string
          promotion_prize_id: string
          receipt_erased_at: string | null
          receipt_path: string | null
          receipt_uploaded_at: string | null
          status: Database["public"]["Enums"]["winner_status"]
          updated_at: string
        }
        Insert: {
          awarded_rank: number
          company_id: string
          created_at?: string
          deadline_at?: string | null
          draw_id: string
          id?: string
          member_id: string
          participation_id: string
          promotion_prize_id: string
          receipt_erased_at?: string | null
          receipt_path?: string | null
          receipt_uploaded_at?: string | null
          status?: Database["public"]["Enums"]["winner_status"]
          updated_at?: string
        }
        Update: {
          awarded_rank?: number
          company_id?: string
          created_at?: string
          deadline_at?: string | null
          draw_id?: string
          id?: string
          member_id?: string
          participation_id?: string
          promotion_prize_id?: string
          receipt_erased_at?: string | null
          receipt_path?: string | null
          receipt_uploaded_at?: string | null
          status?: Database["public"]["Enums"]["winner_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "winners_draw_fk"
            columns: ["draw_id", "company_id"]
            isOneToOne: false
            referencedRelation: "draws"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "winners_member_link_fk"
            columns: ["member_id", "company_id"]
            isOneToOne: false
            referencedRelation: "member_company_links"
            referencedColumns: ["member_id", "company_id"]
          },
          {
            foreignKeyName: "winners_participation_fk"
            columns: ["participation_id", "company_id"]
            isOneToOne: false
            referencedRelation: "participations"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "winners_promotion_prize_fk"
            columns: ["promotion_prize_id", "company_id"]
            isOneToOne: false
            referencedRelation: "promotion_prizes"
            referencedColumns: ["id", "company_id"]
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
      apply_draw: {
        Args: {
          p_company_id: string
          p_organization_id: string
          p_participation_ids: string[]
          p_promotion_id: string
          p_units: Json
        }
        Returns: string
      }
      apply_inventory_movement: {
        Args: {
          p_company_id: string
          p_from: Database["public"]["Enums"]["inventory_bucket"]
          p_idempotency_key: string
          p_note: string
          p_prize_id: string
          p_promotion_prize_id?: string
          p_quantity: number
          p_to: Database["public"]["Enums"]["inventory_bucket"]
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
        }
        Returns: string
      }
      apply_member_candidates: {
        Args: {
          p_cpf_hash: string
          p_email: string
          p_org: string
          p_passport: string
          p_phone: string
        }
        Returns: string[]
      }
      apply_member_creation: {
        Args: {
          p_actor: string
          p_address_complement: string
          p_address_line: string
          p_address_number: string
          p_birth_date: string
          p_city: string
          p_company_id: string
          p_cpf_hash: string
          p_cpf_last_digits: string
          p_discovery_source: string
          p_email: string
          p_first_contact_at: string
          p_first_contact_origin: string
          p_full_name: string
          p_neighbourhood: string
          p_passport: string
          p_phone: string
          p_postal_code: string
          p_state: string
        }
        Returns: string
      }
      apply_member_field_confirmations: {
        Args: {
          p_after: Json
          p_before: Json
          p_member_id: string
          p_organization_id: string
        }
        Returns: undefined
      }
      apply_member_link: {
        Args: {
          p_actor: string
          p_company_id: string
          p_member_id: string
          p_org: string
        }
        Returns: boolean
      }
      apply_member_lookup: {
        Args: {
          p_cpf_hash: string
          p_email: string
          p_org: string
          p_passport: string
          p_phone: string
        }
        Returns: string
      }
      apply_participation: {
        Args: {
          p_answers?: Json
          p_member_id: string
          p_participated_at: string
          p_promotion_id: string
          p_source: Database["public"]["Enums"]["participation_source"]
        }
        Returns: Json
      }
      apply_winner_transition: {
        Args: {
          p_deadline_at?: string
          p_reason: string
          p_to: Database["public"]["Enums"]["winner_status"]
          p_winner_id: string
        }
        Returns: undefined
      }
      archive_member: { Args: { p_member_id: string }; Returns: undefined }
      archive_music_reference: {
        Args: {
          p_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
        }
        Returns: undefined
      }
      archive_prize: { Args: { p_prize_id: string }; Returns: undefined }
      archive_promotion: {
        Args: { p_promotion_id: string }
        Returns: undefined
      }
      archive_song: { Args: { p_song_id: string }; Returns: undefined }
      assert_song_references_live: {
        Args: {
          p_artist_id: string
          p_company_id: string
          p_genre_id: string
          p_label_id: string
        }
        Returns: undefined
      }
      assign_company_role: {
        Args: { p_company_id: string; p_role_id: string; p_user_id: string }
        Returns: string
      }
      attach_delivery_receipt: {
        Args: { p_path: string; p_winner_id: string }
        Returns: undefined
      }
      backfill_member_field_confirmations: { Args: never; Returns: undefined }
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
      cancel_delivery: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
      cancel_draw: {
        Args: { p_draw_id: string; p_reason: string }
        Returns: undefined
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
      claim_conversation_turn: {
        Args: {
          p_integration_id: string
          p_phone: string
          p_stale_after: string
        }
        Returns: string
      }
      claim_outbox_batch: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          body: string
          id: string
          interactive: Json
          phone_number_id: string
          to_phone: string
        }[]
      }
      complete_password_change: { Args: never; Returns: undefined }
      complete_whatsapp_conversation: {
        Args: {
          p_completed_at: string
          p_dedupe_key: string
          p_event_id: string
          p_fields: Json
          p_integration_id: string
          p_member_id: string
          p_promotion_id: string
          p_questions: Json
          p_to_phone: string
        }
        Returns: Json
      }
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
      create_music_reference: {
        Args: {
          p_company_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
          p_legacy_id?: string
          p_name: string
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
          p_max_entries_per_member?: number
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
      create_song: {
        Args: {
          p_artist_id: string
          p_company_id: string
          p_duration_seconds?: number
          p_genre_id?: string
          p_internal_code?: string
          p_label_id?: string
          p_legacy_id?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_title: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: string
      }
      delete_role: { Args: { p_role_id: string }; Returns: undefined }
      deliver_prize: {
        Args: { p_note?: string; p_winner_id: string }
        Returns: undefined
      }
      draw_eligible_participations: {
        Args: { p_promotion_id: string }
        Returns: {
          member_id: string
          participated_at: string
          participation_id: string
        }[]
      }
      draw_hat_has_wrong_answers: {
        Args: { p_participation_ids: string[]; p_promotion_id: string }
        Returns: boolean
      }
      due_whatsapp_events: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          id: string
        }[]
      }
      enqueue_whatsapp_outbound: {
        Args: {
          p_body: string
          p_dedupe_key: string
          p_integration_id: string
          p_interactive: Json
          p_to_phone: string
        }
        Returns: string
      }
      ensure_inventory_balance_row: {
        Args: { p_company_id: string; p_org: string; p_prize_id: string }
        Returns: undefined
      }
      ensure_promotion_prize_balance_row: {
        Args: {
          p_company_id: string
          p_org: string
          p_prize_id: string
          p_promotion_prize_id: string
        }
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
      finish_whatsapp_event: {
        Args: {
          p_event_id: string
          p_outcome: string
          p_part: string
          p_status: string
        }
        Returns: Json
      }
      finish_whatsapp_turn: {
        Args: { p_event_id: string; p_outcome: string }
        Returns: Json
      }
      get_draw: { Args: { p_draw_id: string }; Returns: Json }
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
      import_participations: {
        Args: { p_promotion_id: string; p_rows: Json }
        Returns: Json
      }
      ingest_whatsapp_event: {
        Args: { p_event_id: string; p_window_seconds?: number }
        Returns: Json
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
      link_prize_to_promotion: {
        Args: {
          p_note?: string
          p_prize_id: string
          p_promotion_id: string
          p_quantity: number
        }
        Returns: string
      }
      list_draws: {
        Args: { p_promotion_id: string }
        Returns: {
          algorithm_version: number
          cancellation_reason: string
          cancelled_at: string
          drawn_at: string
          entry_count: number
          id: string
          seed: string
          status: Database["public"]["Enums"]["draw_status"]
          winner_count: number
        }[]
      }
      list_linkable_prizes: {
        Args: { p_company_id: string; p_search?: string }
        Returns: {
          available: number
          name: string
          prize_id: string
        }[]
      }
      list_manageable_companies: {
        Args: { p_organization_id: string; p_permission: string }
        Returns: {
          id: string
          name: string
          status: Database["public"]["Enums"]["company_status"]
        }[]
      }
      list_movements: {
        Args: {
          p_company_id: string
          p_cursor_at?: string
          p_cursor_id?: string
          p_from?: string
          p_limit?: number
          p_prize_id?: string
          p_promotion_id?: string
          p_to?: string
          p_type?: Database["public"]["Enums"]["inventory_movement_type"]
          p_walking_back?: boolean
        }
        Returns: {
          actor_id: string
          actor_name: string
          created_at: string
          from_bucket: Database["public"]["Enums"]["inventory_bucket"]
          movement_id: string
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note: string
          prize_id: string
          prize_name: string
          promotion_archived: boolean
          promotion_id: string
          promotion_name: string
          quantity: number
          to_bucket: Database["public"]["Enums"]["inventory_bucket"]
          total_count: number
        }[]
      }
      list_participations: {
        Args: {
          p_answered_correctly?: boolean
          p_company_id: string
          p_cursor_at?: string
          p_cursor_id?: string
          p_from?: string
          p_limit?: number
          p_option_id?: string
          p_promotion_id?: string
          p_search?: string
          p_source?: Database["public"]["Enums"]["participation_source"]
          p_status?: Database["public"]["Enums"]["participation_status"]
          p_to?: string
          p_walking_back?: boolean
        }
        Returns: {
          already_won: boolean
          id: string
          listener_cpf_last_digits: string
          listener_name: string
          listener_phone: string
          member_id: string
          participated_at: string
          promotion_id: string
          promotion_name: string
          source: Database["public"]["Enums"]["participation_source"]
          status: Database["public"]["Enums"]["participation_status"]
          total_count: number
        }[]
      }
      list_pickups: {
        Args: {
          p_company_id: string
          p_cursor_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_promotion_id?: string
          p_search?: string
          p_status?: Database["public"]["Enums"]["winner_status"]
          p_walking_back?: boolean
        }
        Returns: {
          allows_return_to_stock: boolean
          deadline_at: string
          draw_status: Database["public"]["Enums"]["draw_status"]
          member_id: string
          member_name: string
          member_phone: string
          prize_id: string
          prize_name: string
          promotion_id: string
          promotion_name: string
          status: Database["public"]["Enums"]["winner_status"]
          total_count: number
          winner_id: string
        }[]
      }
      list_promotion_prizes: {
        Args: { p_promotion_id: string }
        Returns: {
          drawn: number
          linked: number
          prize_id: string
          prize_name: string
          promotion_prize_id: string
        }[]
      }
      member_block_active: {
        Args: {
          p_company_id: string
          p_member_id: string
          p_organization_id: string
        }
        Returns: boolean
      }
      member_field_value: {
        Args: {
          p_field: Database["public"]["Enums"]["promotion_requested_field"]
          p_member_id: string
        }
        Returns: string
      }
      member_field_values: { Args: { p_member_id: string }; Returns: Json }
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
      music_reference_table: {
        Args: { p_kind: Database["public"]["Enums"]["music_reference_kind"] }
        Returns: string
      }
      normalize_email: { Args: { p_email: string }; Returns: string }
      normalize_phone: { Args: { p_phone: string }; Returns: string }
      participation_status_for: {
        Args: { p_member_id: string; p_promotion_id: string; p_when: string }
        Returns: Database["public"]["Enums"]["participation_status"]
      }
      project_promotion_prize_movement: {
        Args: {
          p_promotion_prize_id: string
          p_quantity: number
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
        }
        Returns: undefined
      }
      promotion_participation_correctness: {
        Args: { p_promotion_id: string }
        Returns: {
          answered_correctly: boolean
          participation_id: string
        }[]
      }
      promotion_write_error: {
        Args: {
          p_constraint?: string
          p_hashtag: string
          p_site_code: number
          p_sqlstate: string
        }
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
      prune_outbox_messages: {
        Args: { p_older_than?: string }
        Returns: number
      }
      prune_webhook_payloads: {
        Args: { p_older_than?: string }
        Returns: number
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
      reclaim_stale_whatsapp_claims: {
        Args: { p_stale_after?: string }
        Returns: {
          events: number
          messages: number
        }[]
      }
      reconcile_inventory: {
        Args: { p_company_id: string }
        Returns: {
          bucket: string
          computed: number
          prize_id: string
          prize_name: string
          promotion_name: string
          promotion_prize_id: string
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
      record_participation: {
        Args: {
          p_answers?: Json
          p_member_id: string
          p_participated_at: string
          p_promotion_id: string
          p_source: Database["public"]["Enums"]["participation_source"]
        }
        Returns: Json
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
      record_whatsapp_refusal: {
        Args: {
          p_body: string
          p_dedupe_key: string
          p_event_id: string
          p_integration_id: string
          p_member_id: string
          p_promotion_id: string
          p_refused_at: string
          p_to_phone: string
        }
        Returns: string
      }
      release_conversation_turn: {
        Args: { p_integration_id: string; p_phone: string; p_token: string }
        Returns: undefined
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
      reopen_pickup_deadline: {
        Args: { p_deadline_at: string; p_reason: string; p_winner_id: string }
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
      resolve_or_create_member: {
        Args: {
          p_company_id: string
          p_cpf_hash?: string
          p_cpf_last_digits?: string
          p_email?: string
          p_full_name: string
          p_passport?: string
          p_phone?: string
        }
        Returns: Json
      }
      return_prize: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
      return_promotion_prizes: {
        Args: { p_company_id: string; p_note: string; p_promotion_id: string }
        Returns: number
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      run_draw: {
        Args: {
          p_participation_ids?: string[]
          p_promotion_id: string
          p_units?: Json
        }
        Returns: string
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
      start_whatsapp_conversation: {
        Args: {
          p_integration_id: string
          p_member_id: string
          p_phone: string
          p_promotion_id: string
          p_window_seconds: number
        }
        Returns: Json
      }
      suspend_company: {
        Args: { p_company_id: string; p_reason: string }
        Returns: undefined
      }
      sweep_expired_conversations: {
        Args: never
        Returns: {
          conversations: number
          leases: number
        }[]
      }
      unlink_prize_from_promotion: {
        Args: {
          p_note?: string
          p_prize_id: string
          p_promotion_id: string
          p_quantity: number
        }
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
      update_music_reference: {
        Args: {
          p_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
          p_name: string
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
          p_max_entries_per_member?: number
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
      update_song: {
        Args: {
          p_artist_id: string
          p_duration_seconds?: number
          p_genre_id?: string
          p_internal_code?: string
          p_label_id?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_song_id: string
          p_title: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: undefined
      }
      validate_invitation: { Args: { p_token_hash: string }; Returns: Json }
      whatsapp_conversation_steps: {
        Args: { p_member_id: string; p_promotion_id: string }
        Returns: Json
      }
      whatsapp_local_phone: { Args: { p_wa_phone: string }; Returns: string }
      whatsapp_prompt_context: {
        Args: { p_promotion_id: string }
        Returns: Json
      }
      whatsapp_reply_body: {
        Args: { p_member_id: string; p_promotion_id: string; p_status: string }
        Returns: string
      }
      write_off_prize: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
    }
    Enums: {
      company_status: "active" | "suspended"
      contact_request_status: "new" | "contacted" | "converted" | "discarded"
      draw_status: "COMPLETED" | "CANCELLED"
      integration_provider: "WHATSAPP"
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
        | "DELIVERY_CANCEL"
        | "RETURN_PENDING"
        | "RETURN_PENDING_CANCEL"
        | "RETURN_TO_STOCK"
        | "WRITE_OFF"
      invitation_status: "pending" | "accepted" | "revoked"
      member_block_kind: "draw_ban" | "suspension"
      member_consent_type: "rules" | "image_use" | "sponsor_communication"
      member_erasure_reason:
        | "subject_request"
        | "court_order"
        | "internal_policy"
      music_nationality: "DOMESTIC" | "INTERNATIONAL"
      music_reference_kind: "GENRE" | "LABEL" | "ARTIST" | "SHOW"
      music_request_channel: "MANUAL" | "IMPORT"
      music_vocal: "MALE" | "FEMALE" | "DUO" | "GROUP" | "INSTRUMENTAL"
      org_role: "owner" | "member"
      outbox_status: "PENDING" | "SENDING" | "SENT" | "FAILED"
      participation_source: "MANUAL" | "IMPORT" | "WHATSAPP"
      participation_status: "VALID" | "DUPLICATE" | "TOO_SOON" | "OVER_LIMIT"
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
      webhook_event_status: "RECEIVED" | "PROCESSING" | "DONE" | "FAILED"
      winner_status:
        | "AWAITING_PICKUP"
        | "RETURN_PENDING"
        | "DELIVERED"
        | "RETURNED"
        | "WRITTEN_OFF"
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
      draw_status: ["COMPLETED", "CANCELLED"],
      integration_provider: ["WHATSAPP"],
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
        "DELIVERY_CANCEL",
        "RETURN_PENDING",
        "RETURN_PENDING_CANCEL",
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
      music_nationality: ["DOMESTIC", "INTERNATIONAL"],
      music_reference_kind: ["GENRE", "LABEL", "ARTIST", "SHOW"],
      music_request_channel: ["MANUAL", "IMPORT"],
      music_vocal: ["MALE", "FEMALE", "DUO", "GROUP", "INSTRUMENTAL"],
      org_role: ["owner", "member"],
      outbox_status: ["PENDING", "SENDING", "SENT", "FAILED"],
      participation_source: ["MANUAL", "IMPORT", "WHATSAPP"],
      participation_status: ["VALID", "DUPLICATE", "TOO_SOON", "OVER_LIMIT"],
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
      webhook_event_status: ["RECEIVED", "PROCESSING", "DONE", "FAILED"],
      winner_status: [
        "AWAITING_PICKUP",
        "RETURN_PENDING",
        "DELIVERED",
        "RETURNED",
        "WRITTEN_OFF",
      ],
    },
  },
} as const

