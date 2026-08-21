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
      albums: {
        Row: {
          company_id: string
          cover_md5: string | null
          created_at: string
          created_by: string | null
          deezer_album_id: number | null
          deleted_at: string | null
          id: string
          legacy_id: string | null
          organization_id: string
          release_date: string | null
          thumb_url: string | null
          title: string
          upc: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          cover_md5?: string | null
          created_at?: string
          created_by?: string | null
          deezer_album_id?: number | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          organization_id: string
          release_date?: string | null
          thumb_url?: string | null
          title: string
          upc?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          cover_md5?: string | null
          created_at?: string
          created_by?: string | null
          deezer_album_id?: number | null
          deleted_at?: string | null
          id?: string
          legacy_id?: string | null
          organization_id?: string
          release_date?: string | null
          thumb_url?: string | null
          title?: string
          upc?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "albums_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "albums_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_credential_scopes: {
        Row: {
          credential_id: string
          permission_code: string
        }
        Insert: {
          credential_id: string
          permission_code: string
        }
        Update: {
          credential_id?: string
          permission_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_credential_scopes_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "api_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_credential_scopes_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
        ]
      }
      api_credentials: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          organization_id: string
          revoked_at: string | null
          revoked_by: string | null
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          organization_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          organization_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_credentials_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "api_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
          address_complement: string | null
          address_line: string | null
          address_number: string | null
          broadcast_band: Database["public"]["Enums"]["broadcast_band"] | null
          city: string | null
          contact_email: string | null
          contact_phone: string | null
          country: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          email_from_address: string | null
          email_from_name: string | null
          email_reply_to: string | null
          facebook_url: string | null
          fiscal_email: string | null
          frequency_khz: number | null
          id: string
          instagram_url: string | null
          latitude: number | null
          legal_name: string | null
          listener_locale: string | null
          longitude: number | null
          municipal_registration: string | null
          name: string
          neighbourhood: string | null
          organization_id: string
          postal_code: string | null
          provisioned_at: string
          provisioned_by: string | null
          state: string | null
          status: Database["public"]["Enums"]["company_status"]
          suspended_at: string | null
          suspension_reason: string | null
          tagline: string | null
          tax_id: string | null
          thumb_url: string | null
          timezone: string
          updated_at: string
          website_url: string | null
          youtube_url: string | null
        }
        Insert: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          broadcast_band?: Database["public"]["Enums"]["broadcast_band"] | null
          city?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          email_from_address?: string | null
          email_from_name?: string | null
          email_reply_to?: string | null
          facebook_url?: string | null
          fiscal_email?: string | null
          frequency_khz?: number | null
          id?: string
          instagram_url?: string | null
          latitude?: number | null
          legal_name?: string | null
          listener_locale?: string | null
          longitude?: number | null
          municipal_registration?: string | null
          name: string
          neighbourhood?: string | null
          organization_id: string
          postal_code?: string | null
          provisioned_at?: string
          provisioned_by?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          tagline?: string | null
          tax_id?: string | null
          thumb_url?: string | null
          timezone?: string
          updated_at?: string
          website_url?: string | null
          youtube_url?: string | null
        }
        Update: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          broadcast_band?: Database["public"]["Enums"]["broadcast_band"] | null
          city?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          email_from_address?: string | null
          email_from_name?: string | null
          email_reply_to?: string | null
          facebook_url?: string | null
          fiscal_email?: string | null
          frequency_khz?: number | null
          id?: string
          instagram_url?: string | null
          latitude?: number | null
          legal_name?: string | null
          listener_locale?: string | null
          longitude?: number | null
          municipal_registration?: string | null
          name?: string
          neighbourhood?: string | null
          organization_id?: string
          postal_code?: string | null
          provisioned_at?: string
          provisioned_by?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          tagline?: string | null
          tax_id?: string | null
          thumb_url?: string | null
          timezone?: string
          updated_at?: string
          website_url?: string | null
          youtube_url?: string | null
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
      data_deletion_requests: {
        Row: {
          company_name: string | null
          created_at: string
          email: string
          id: string
          ip_hash: string | null
          message: string | null
          name: string
          phone: string | null
          protocol: string
          status: Database["public"]["Enums"]["data_deletion_request_status"]
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
          protocol?: string
          status?: Database["public"]["Enums"]["data_deletion_request_status"]
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
          protocol?: string
          status?: Database["public"]["Enums"]["data_deletion_request_status"]
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
      geocoded_places: {
        Row: {
          attempts: number
          city: string | null
          country: string | null
          failed_at: string | null
          failure_reason: string | null
          id: string
          latitude: number | null
          longitude: number | null
          neighbourhood: string | null
          place_key: string
          precision: string | null
          provider: string
          queued_at: string
          resolved_at: string | null
          state: string | null
        }
        Insert: {
          attempts?: number
          city?: string | null
          country?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          neighbourhood?: string | null
          place_key: string
          precision?: string | null
          provider?: string
          queued_at?: string
          resolved_at?: string | null
          state?: string | null
        }
        Update: {
          attempts?: number
          city?: string | null
          country?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          neighbourhood?: string | null
          place_key?: string
          precision?: string | null
          provider?: string
          queued_at?: string
          resolved_at?: string | null
          state?: string | null
        }
        Relationships: []
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
          invoice_number: string | null
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note: string | null
          organization_id: string
          prize_id: string
          promotion_prize_id: string | null
          quantity: number
          reserved_for_show_id: string | null
          reverses_movement_id: string | null
          to_bucket: Database["public"]["Enums"]["inventory_bucket"] | null
          total_amount: number | null
          unit_amount: number | null
          vendor_id: string | null
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          created_at?: string
          from_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          id?: string
          idempotency_key?: string | null
          invoice_number?: string | null
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note?: string | null
          organization_id: string
          prize_id: string
          promotion_prize_id?: string | null
          quantity: number
          reserved_for_show_id?: string | null
          reverses_movement_id?: string | null
          to_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          total_amount?: number | null
          unit_amount?: number | null
          vendor_id?: string | null
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          created_at?: string
          from_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          id?: string
          idempotency_key?: string | null
          invoice_number?: string | null
          movement_type?: Database["public"]["Enums"]["inventory_movement_type"]
          note?: string | null
          organization_id?: string
          prize_id?: string
          promotion_prize_id?: string | null
          quantity?: number
          reserved_for_show_id?: string | null
          reverses_movement_id?: string | null
          to_bucket?: Database["public"]["Enums"]["inventory_bucket"] | null
          total_amount?: number | null
          unit_amount?: number | null
          vendor_id?: string | null
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
          {
            foreignKeyName: "inventory_movements_reversal_company_fk"
            columns: ["reverses_movement_id", "company_id"]
            isOneToOne: false
            referencedRelation: "inventory_movements"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "inventory_movements_show_company_fk"
            columns: ["reserved_for_show_id", "company_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "inventory_movements_vendor_company_fk"
            columns: ["vendor_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vendors"
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
      job_health: {
        Row: {
          alerted_at: string | null
          consecutive_failures: number
          job_name: string
          last_counters: Json | null
          last_started_at: string | null
          last_success_at: string | null
          max_silence: string
        }
        Insert: {
          alerted_at?: string | null
          consecutive_failures?: number
          job_name: string
          last_counters?: Json | null
          last_started_at?: string | null
          last_success_at?: string | null
          max_silence: string
        }
        Update: {
          alerted_at?: string | null
          consecutive_failures?: number
          job_name?: string
          last_counters?: Json | null
          last_started_at?: string | null
          last_success_at?: string | null
          max_silence?: string
        }
        Relationships: []
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
          birth_md: number | null
          city: string | null
          country: string | null
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
          gender: string | null
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
          birth_md?: number | null
          city?: string | null
          country?: string | null
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
          gender?: string | null
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
          birth_md?: number | null
          city?: string | null
          country?: string | null
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
          gender?: string | null
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
      message_campaign_recipients: {
        Row: {
          address: string | null
          attempts: number
          campaign_id: string
          channel: Database["public"]["Enums"]["message_channel"]
          claimed_at: string | null
          error_code: string | null
          error_description: string | null
          id: string
          member_id: string
          next_attempt_at: string
          provider_message_id: string | null
          status: Database["public"]["Enums"]["campaign_recipient_status"]
          variables: Json
        }
        Insert: {
          address?: string | null
          attempts?: number
          campaign_id: string
          channel: Database["public"]["Enums"]["message_channel"]
          claimed_at?: string | null
          error_code?: string | null
          error_description?: string | null
          id?: string
          member_id: string
          next_attempt_at?: string
          provider_message_id?: string | null
          status?: Database["public"]["Enums"]["campaign_recipient_status"]
          variables?: Json
        }
        Update: {
          address?: string | null
          attempts?: number
          campaign_id?: string
          channel?: Database["public"]["Enums"]["message_channel"]
          claimed_at?: string | null
          error_code?: string | null
          error_description?: string | null
          id?: string
          member_id?: string
          next_attempt_at?: string
          provider_message_id?: string | null
          status?: Database["public"]["Enums"]["campaign_recipient_status"]
          variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "message_campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "message_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_campaign_recipients_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      message_campaigns: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          company_id: string
          created_at: string
          created_by: string | null
          failed_count: number
          finished_at: string | null
          id: string
          list_id: string
          organization_id: string
          sent_count: number
          started_at: string | null
          status: Database["public"]["Enums"]["campaign_status"]
          suppressed_count: number
          template_id: string
          total_recipients: number
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          company_id: string
          created_at?: string
          created_by?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          list_id: string
          organization_id: string
          sent_count?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["campaign_status"]
          suppressed_count?: number
          template_id: string
          total_recipients?: number
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          channel?: Database["public"]["Enums"]["message_channel"]
          company_id?: string
          created_at?: string
          created_by?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          list_id?: string
          organization_id?: string
          sent_count?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["campaign_status"]
          suppressed_count?: number
          template_id?: string
          total_recipients?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_campaigns_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "message_campaigns_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "send_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_campaigns_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          from_email: string | null
          from_name: string | null
          id: string
          internal_name: string
          language: string | null
          name: string | null
          organization_id: string
          otp_button: boolean
          purpose: Database["public"]["Enums"]["template_purpose"] | null
          reply_to: string | null
          subject: string | null
          updated_at: string
          updated_by: string | null
          variables: Database["public"]["Enums"]["template_variable"][]
        }
        Insert: {
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          internal_name: string
          language?: string | null
          name?: string | null
          organization_id: string
          otp_button?: boolean
          purpose?: Database["public"]["Enums"]["template_purpose"] | null
          reply_to?: string | null
          subject?: string | null
          updated_at?: string
          updated_by?: string | null
          variables?: Database["public"]["Enums"]["template_variable"][]
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["message_channel"]
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          internal_name?: string
          language?: string | null
          name?: string | null
          organization_id?: string
          otp_button?: boolean
          purpose?: Database["public"]["Enums"]["template_purpose"] | null
          reply_to?: string | null
          subject?: string | null
          updated_at?: string
          updated_by?: string | null
          variables?: Database["public"]["Enums"]["template_variable"][]
        }
        Relationships: [
          {
            foreignKeyName: "message_templates_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "message_templates_organization_id_fkey"
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
      music_merges: {
        Row: {
          children_moved: number
          company_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["music_merge_kind"]
          loser_id: string
          merged_by: string | null
          organization_id: string
          reason: string
          winner_id: string
        }
        Insert: {
          children_moved: number
          company_id: string
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["music_merge_kind"]
          loser_id: string
          merged_by?: string | null
          organization_id: string
          reason: string
          winner_id: string
        }
        Update: {
          children_moved?: number
          company_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["music_merge_kind"]
          loser_id?: string
          merged_by?: string | null
          organization_id?: string
          reason?: string
          winner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "music_merges_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "music_merges_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      music_requests: {
        Row: {
          cancelled_at: string | null
          cancelled_by: string | null
          channel: Database["public"]["Enums"]["music_request_channel"]
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          external_id: string | null
          id: string
          legacy_id: string | null
          listener_note: string | null
          member_id: string
          organization_id: string
          play_status:
            | Database["public"]["Enums"]["music_request_play_status"]
            | null
          played_at: string | null
          played_by: string | null
          read_at: string | null
          read_by: string | null
          read_status:
            | Database["public"]["Enums"]["music_request_read_status"]
            | null
          requested_at: string
          show_id: string | null
          song_id: string
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          channel?: Database["public"]["Enums"]["music_request_channel"]
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          external_id?: string | null
          id?: string
          legacy_id?: string | null
          listener_note?: string | null
          member_id: string
          organization_id: string
          play_status?:
            | Database["public"]["Enums"]["music_request_play_status"]
            | null
          played_at?: string | null
          played_by?: string | null
          read_at?: string | null
          read_by?: string | null
          read_status?:
            | Database["public"]["Enums"]["music_request_read_status"]
            | null
          requested_at?: string
          show_id?: string | null
          song_id: string
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          channel?: Database["public"]["Enums"]["music_request_channel"]
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          external_id?: string | null
          id?: string
          legacy_id?: string | null
          listener_note?: string | null
          member_id?: string
          organization_id?: string
          play_status?:
            | Database["public"]["Enums"]["music_request_play_status"]
            | null
          played_at?: string | null
          played_by?: string | null
          read_at?: string | null
          read_by?: string | null
          read_status?:
            | Database["public"]["Enums"]["music_request_read_status"]
            | null
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
          address_complement: string | null
          address_line: string | null
          address_number: string | null
          billing_entity: Database["public"]["Enums"]["billing_entity"]
          city: string | null
          created_at: string
          deleted_at: string | null
          fiscal_email: string | null
          id: string
          legal_name: string | null
          municipal_registration: string | null
          name: string
          neighbourhood: string | null
          postal_code: string | null
          state: string | null
          suspended_at: string | null
          suspended_by: string | null
          suspension_reason: string | null
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          billing_entity?: Database["public"]["Enums"]["billing_entity"]
          city?: string | null
          created_at?: string
          deleted_at?: string | null
          fiscal_email?: string | null
          id?: string
          legal_name?: string | null
          municipal_registration?: string | null
          name: string
          neighbourhood?: string | null
          postal_code?: string | null
          state?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          suspension_reason?: string | null
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          address_complement?: string | null
          address_line?: string | null
          address_number?: string | null
          billing_entity?: Database["public"]["Enums"]["billing_entity"]
          city?: string | null
          created_at?: string
          deleted_at?: string | null
          fiscal_email?: string | null
          id?: string
          legal_name?: string | null
          municipal_registration?: string | null
          name?: string
          neighbourhood?: string | null
          postal_code?: string | null
          state?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          suspension_reason?: string | null
          tax_id?: string | null
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
          template_language: string | null
          template_name: string | null
          template_otp_button: boolean
          template_variables: Json | null
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
          template_language?: string | null
          template_name?: string | null
          template_otp_button?: boolean
          template_variables?: Json | null
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
          template_language?: string | null
          template_name?: string | null
          template_otp_button?: boolean
          template_variables?: Json | null
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
          photo_url: string | null
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
          photo_url?: string | null
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
          photo_url?: string | null
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
          locale: string | null
          must_change_password: boolean
          provisional_expires_at: string | null
          theme: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email: string
          full_name?: string | null
          id: string
          locale?: string | null
          must_change_password?: boolean
          provisional_expires_at?: string | null
          theme?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          locale?: string | null
          must_change_password?: boolean
          provisional_expires_at?: string | null
          theme?: string | null
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
          moderation_guidelines: string | null
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
          moderation_guidelines?: string | null
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
          moderation_guidelines?: string | null
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
          authorization_certificate: string | null
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
          rules: string | null
          show_id: string | null
          site_integration_code: number | null
          starts_at: string
          thumb_url: string | null
          updated_at: string
          use_art: boolean
          web_enabled: boolean
          whatsapp_enabled: boolean
          yes_button_label: string | null
        }
        Insert: {
          allow_multiple_entries?: boolean
          art_url?: string | null
          authorization_certificate?: string | null
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
          rules?: string | null
          show_id?: string | null
          site_integration_code?: number | null
          starts_at: string
          thumb_url?: string | null
          updated_at?: string
          use_art?: boolean
          web_enabled?: boolean
          whatsapp_enabled?: boolean
          yes_button_label?: string | null
        }
        Update: {
          allow_multiple_entries?: boolean
          art_url?: string | null
          authorization_certificate?: string | null
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
          rules?: string | null
          show_id?: string | null
          site_integration_code?: number | null
          starts_at?: string
          thumb_url?: string | null
          updated_at?: string
          use_art?: boolean
          web_enabled?: boolean
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
          {
            foreignKeyName: "promotions_show_fk"
            columns: ["show_id", "company_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id", "company_id"]
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
      report_runs: {
        Row: {
          attempts: number
          byte_size: number | null
          company_ids: string[]
          expires_at: string | null
          filters: Json
          finished_at: string | null
          format: Database["public"]["Enums"]["report_format"]
          id: string
          last_error: string | null
          organization_id: string
          payload: Json | null
          report_type: Database["public"]["Enums"]["report_type"]
          requested_at: string
          requested_by: string
          row_count: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["report_status"]
          storage_path: string | null
          withheld: string[]
        }
        Insert: {
          attempts?: number
          byte_size?: number | null
          company_ids: string[]
          expires_at?: string | null
          filters?: Json
          finished_at?: string | null
          format: Database["public"]["Enums"]["report_format"]
          id?: string
          last_error?: string | null
          organization_id: string
          payload?: Json | null
          report_type: Database["public"]["Enums"]["report_type"]
          requested_at?: string
          requested_by: string
          row_count?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          storage_path?: string | null
          withheld?: string[]
        }
        Update: {
          attempts?: number
          byte_size?: number | null
          company_ids?: string[]
          expires_at?: string | null
          filters?: Json
          finished_at?: string | null
          format?: Database["public"]["Enums"]["report_format"]
          id?: string
          last_error?: string | null
          organization_id?: string
          payload?: Json | null
          report_type?: Database["public"]["Enums"]["report_type"]
          requested_at?: string
          requested_by?: string
          row_count?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          storage_path?: string | null
          withheld?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "report_runs_organization_id_fkey"
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
      send_list_members: {
        Row: {
          list_id: string
          member_id: string
        }
        Insert: {
          list_id: string
          member_id: string
        }
        Update: {
          list_id?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_list_members_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "send_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_list_members_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      send_lists: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          filters: Json
          id: string
          kind: Database["public"]["Enums"]["send_list_kind"]
          name: string
          organization_id: string
          source: Database["public"]["Enums"]["send_list_source"]
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          filters?: Json
          id?: string
          kind: Database["public"]["Enums"]["send_list_kind"]
          name: string
          organization_id: string
          source: Database["public"]["Enums"]["send_list_source"]
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          filters?: Json
          id?: string
          kind?: Database["public"]["Enums"]["send_list_kind"]
          name?: string
          organization_id?: string
          source?: Database["public"]["Enums"]["send_list_source"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_lists_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "send_lists_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      show_schedules: {
        Row: {
          band: number
          company_id: string
          created_at: string
          ends_at: string
          id: string
          organization_id: string
          show_id: string
          starts_at: string
          weekday: number
        }
        Insert: {
          band: number
          company_id: string
          created_at?: string
          ends_at: string
          id?: string
          organization_id: string
          show_id: string
          starts_at: string
          weekday: number
        }
        Update: {
          band?: number
          company_id?: string
          created_at?: string
          ends_at?: string
          id?: string
          organization_id?: string
          show_id?: string
          starts_at?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "show_schedules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "show_schedules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "show_schedules_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      shows: {
        Row: {
          age_rating: Database["public"]["Enums"]["show_age_rating"] | null
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          ends_on: string | null
          id: string
          kind: Database["public"]["Enums"]["show_kind"] | null
          legacy_id: string | null
          name: string
          organization_id: string
          presenter_name: string | null
          producer_name: string | null
          starts_on: string | null
          thumb_url: string | null
          updated_at: string
        }
        Insert: {
          age_rating?: Database["public"]["Enums"]["show_age_rating"] | null
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          ends_on?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["show_kind"] | null
          legacy_id?: string | null
          name: string
          organization_id: string
          presenter_name?: string | null
          producer_name?: string | null
          starts_on?: string | null
          thumb_url?: string | null
          updated_at?: string
        }
        Update: {
          age_rating?: Database["public"]["Enums"]["show_age_rating"] | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          ends_on?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["show_kind"] | null
          legacy_id?: string | null
          name?: string
          organization_id?: string
          presenter_name?: string | null
          producer_name?: string | null
          starts_on?: string | null
          thumb_url?: string | null
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
      song_integrations: {
        Row: {
          artist_name: string | null
          category_name: string | null
          code: string
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          organization_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          artist_name?: string | null
          category_name?: string | null
          code: string
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          organization_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          artist_name?: string | null
          category_name?: string | null
          code?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          organization_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "song_integrations_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "song_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      songs: {
        Row: {
          album_id: string | null
          artist_id: string
          company_id: string
          created_at: string
          created_by: string | null
          deezer_track_id: number | null
          deleted_at: string | null
          duration_seconds: number | null
          external_id: string | null
          genre_id: string | null
          id: string
          internal_code: string | null
          isrc: string | null
          label_id: string | null
          legacy_id: string | null
          nationality: Database["public"]["Enums"]["music_nationality"] | null
          organization_id: string
          songwriter_id: string | null
          title: string
          updated_at: string
          vocal: Database["public"]["Enums"]["music_vocal"] | null
        }
        Insert: {
          album_id?: string | null
          artist_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          deezer_track_id?: number | null
          deleted_at?: string | null
          duration_seconds?: number | null
          external_id?: string | null
          genre_id?: string | null
          id?: string
          internal_code?: string | null
          isrc?: string | null
          label_id?: string | null
          legacy_id?: string | null
          nationality?: Database["public"]["Enums"]["music_nationality"] | null
          organization_id: string
          songwriter_id?: string | null
          title: string
          updated_at?: string
          vocal?: Database["public"]["Enums"]["music_vocal"] | null
        }
        Update: {
          album_id?: string | null
          artist_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          deezer_track_id?: number | null
          deleted_at?: string | null
          duration_seconds?: number | null
          external_id?: string | null
          genre_id?: string | null
          id?: string
          internal_code?: string | null
          isrc?: string | null
          label_id?: string | null
          legacy_id?: string | null
          nationality?: Database["public"]["Enums"]["music_nationality"] | null
          organization_id?: string
          songwriter_id?: string | null
          title?: string
          updated_at?: string
          vocal?: Database["public"]["Enums"]["music_vocal"] | null
        }
        Relationships: [
          {
            foreignKeyName: "songs_album_company_fk"
            columns: ["album_id", "company_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id", "company_id"]
          },
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
          {
            foreignKeyName: "songs_songwriter_company_fk"
            columns: ["songwriter_id", "company_id"]
            isOneToOne: false
            referencedRelation: "songwriters"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      songwriters: {
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
            foreignKeyName: "songwriters_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "songwriters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      station_message_templates: {
        Row: {
          body: string
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          key: Database["public"]["Enums"]["system_message_key"]
          organization_id: string
          updated_at: string
        }
        Insert: {
          body: string
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          key: Database["public"]["Enums"]["system_message_key"]
          organization_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          key?: Database["public"]["Enums"]["system_message_key"]
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "station_message_templates_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "station_message_templates_organization_id_fkey"
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
      unsubscribe_tokens: {
        Row: {
          campaign_label: string | null
          company_id: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          member_id: string
          organization_id: string
          token_hash: string
        }
        Insert: {
          campaign_label?: string | null
          company_id: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          member_id: string
          organization_id: string
          token_hash: string
        }
        Update: {
          campaign_label?: string | null
          company_id?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          member_id?: string
          organization_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "unsubscribe_tokens_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "unsubscribe_tokens_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unsubscribe_tokens_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address_line: string | null
          city: string | null
          company_id: string
          contact_name: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          document: string | null
          email: string | null
          id: string
          legal_name: string | null
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          postal_code: string | null
          state: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          address_line?: string | null
          city?: string | null
          company_id: string
          contact_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          document?: string | null
          email?: string | null
          id?: string
          legal_name?: string | null
          name: string
          notes?: string | null
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          address_line?: string | null
          city?: string | null
          company_id?: string
          contact_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          document?: string | null
          email?: string | null
          id?: string
          legal_name?: string | null
          name?: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendors_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "vendors_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      widget_installations: {
        Row: {
          allowed_origins: string[]
          company_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          enabled: boolean
          id: string
          music_hashtag: string | null
          music_request_cooldown: string
          organization_id: string
          public_key: string
          service_hashtag: string | null
          updated_at: string
        }
        Insert: {
          allowed_origins?: string[]
          company_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          enabled?: boolean
          id?: string
          music_hashtag?: string | null
          music_request_cooldown?: string
          organization_id: string
          public_key: string
          service_hashtag?: string | null
          updated_at?: string
        }
        Update: {
          allowed_origins?: string[]
          company_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          enabled?: boolean
          id?: string
          music_hashtag?: string | null
          music_request_cooldown?: string
          organization_id?: string
          public_key?: string
          service_hashtag?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_installations_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "widget_installations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_link_tokens: {
        Row: {
          company_id: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          member_id: string
          organization_id: string
          promotion_id: string | null
          public_key: string
          purpose: Database["public"]["Enums"]["widget_link_purpose"]
          token_hash: string
        }
        Insert: {
          company_id: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          member_id: string
          organization_id: string
          promotion_id?: string | null
          public_key: string
          purpose: Database["public"]["Enums"]["widget_link_purpose"]
          token_hash: string
        }
        Update: {
          company_id?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          member_id?: string
          organization_id?: string
          promotion_id?: string | null
          public_key?: string
          purpose?: Database["public"]["Enums"]["widget_link_purpose"]
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_link_tokens_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "widget_link_tokens_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_link_tokens_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_link_tokens_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_verifications: {
        Row: {
          attempts: number
          code_hash: string
          company_id: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          installation_id: string
          organization_id: string
          phone: string
        }
        Insert: {
          attempts?: number
          code_hash: string
          company_id: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          installation_id: string
          organization_id: string
          phone: string
        }
        Update: {
          attempts?: number
          code_hash?: string
          company_id?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          installation_id?: string
          organization_id?: string
          phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_verifications_company_org_fk"
            columns: ["company_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "widget_verifications_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "widget_installations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_verifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      api_record_music_request: {
        Args: {
          p_album_title?: string
          p_artist_name?: string
          p_company_id: string
          p_cover_md5?: string
          p_credential_id: string
          p_deezer_album_id?: number
          p_deezer_track_id?: number
          p_duration_seconds?: number
          p_genre_name?: string
          p_internal_code?: string
          p_isrc?: string
          p_label_name?: string
          p_listener_name?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_org: string
          p_phone: string
          p_release_date?: string
          p_request_external_id?: string
          p_requested_at?: string
          p_show_name?: string
          p_song_external_id?: string
          p_title?: string
          p_upc?: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: Json
      }
      api_register_song: {
        Args: {
          p_album_title?: string
          p_artist_name: string
          p_company_id: string
          p_cover_md5?: string
          p_credential_id: string
          p_deezer_album_id?: number
          p_deezer_track_id?: number
          p_duration_seconds?: number
          p_external_id?: string
          p_genre_name?: string
          p_internal_code?: string
          p_isrc?: string
          p_label_name?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_org: string
          p_release_date?: string
          p_title: string
          p_upc?: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: Json
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
          p_invoice_number?: string
          p_note: string
          p_prize_id: string
          p_promotion_prize_id?: string
          p_quantity: number
          p_reverses?: string
          p_show_id?: string
          p_to: Database["public"]["Enums"]["inventory_bucket"]
          p_total_amount?: number
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
          p_unit_amount?: number
          p_vendor_id?: string
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
          p_country?: string
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
      apply_member_field_values: {
        Args: { p_fields: Json; p_member_id: string }
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
      apply_members_marketing_eligible: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_member_ids: string[]
        }
        Returns: {
          eligible: boolean
          member_id: string
        }[]
      }
      apply_music_merge: {
        Args: {
          p_company_id: string
          p_kind: Database["public"]["Enums"]["music_merge_kind"]
          p_loser_ids: string[]
          p_reason: string
          p_winner_id: string
        }
        Returns: number
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
      apply_song_intake: {
        Args: {
          p_actor: string
          p_album_title?: string
          p_artist_name: string
          p_company_id: string
          p_cover_md5?: string
          p_deezer_album_id?: number
          p_deezer_track_id?: number
          p_duration_seconds?: number
          p_external_id: string
          p_genre_name?: string
          p_internal_code?: string
          p_isrc?: string
          p_label_name?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_org: string
          p_release_date?: string
          p_title: string
          p_upc?: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
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
      archive_album: { Args: { p_album_id: string }; Returns: undefined }
      archive_member: { Args: { p_member_id: string }; Returns: undefined }
      archive_message_template: { Args: { p_id: string }; Returns: undefined }
      archive_music_reference: {
        Args: {
          p_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
        }
        Returns: undefined
      }
      archive_music_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      archive_prize: { Args: { p_prize_id: string }; Returns: undefined }
      archive_prize_category: {
        Args: { p_category_id: string }
        Returns: undefined
      }
      archive_promotion: {
        Args: { p_promotion_id: string }
        Returns: undefined
      }
      archive_song: { Args: { p_song_id: string }; Returns: undefined }
      archive_vendor: { Args: { p_vendor_id: string }; Returns: undefined }
      are_origins: { Args: { p_values: string[] }; Returns: boolean }
      assert_song_references_live: {
        Args: {
          p_artist_id: string
          p_company_id: string
          p_genre_id: string
          p_label_id: string
          p_songwriter_id?: string
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
      authenticate_api_credential: {
        Args: { p_scope: string; p_token_hash: string }
        Returns: {
          company_id: string
          credential_id: string
          organization_id: string
          scope_ok: boolean
        }[]
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
      block_organization: {
        Args: { p_organization_id: string; p_reason: string }
        Returns: undefined
      }
      bump_campaign_counters: {
        Args: {
          p_campaign_id: string
          p_failed: number
          p_sent: number
          p_suppressed: number
        }
        Returns: {
          failed_count: number
          sent_count: number
          suppressed_count: number
        }[]
      }
      campaign_whatsapp_sender: {
        Args: { p_company_id: string }
        Returns: string
      }
      cancel_campaign: {
        Args: { p_campaign_id: string; p_reason: string }
        Returns: number
      }
      cancel_delivery: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
      cancel_draw: {
        Args: { p_draw_id: string; p_reason: string }
        Returns: undefined
      }
      cancel_music_request: {
        Args: { p_request_id: string }
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
      check_job_health: {
        Args: never
        Returns: {
          alerted_at: string
          job_name: string
          last_counters: Json
          last_started_at: string
          last_success_at: string
        }[]
      }
      claim_campaign_batch: {
        Args: { p_limit: number }
        Returns: {
          address: string
          attempts: number
          body: string
          campaign_id: string
          channel: Database["public"]["Enums"]["message_channel"]
          company_id: string
          id: string
          phone_number_id: string
          subject: string
          template_language: string
          template_name: string
          variables: Json
        }[]
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
          template_language: string
          template_name: string
          template_otp_button: boolean
          template_variables: Json
          to_phone: string
        }[]
      }
      claim_places_to_geocode: {
        Args: { p_limit?: number }
        Returns: {
          attempts: number
          city: string | null
          country: string | null
          failed_at: string | null
          failure_reason: string | null
          id: string
          latitude: number | null
          longitude: number | null
          neighbourhood: string | null
          place_key: string
          precision: string | null
          provider: string
          queued_at: string
          resolved_at: string | null
          state: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "geocoded_places"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_report_run: {
        Args: never
        Returns: {
          attempts: number
          byte_size: number | null
          company_ids: string[]
          expires_at: string | null
          filters: Json
          finished_at: string | null
          format: Database["public"]["Enums"]["report_format"]
          id: string
          last_error: string | null
          organization_id: string
          payload: Json | null
          report_type: Database["public"]["Enums"]["report_type"]
          requested_at: string
          requested_by: string
          row_count: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["report_status"]
          storage_path: string | null
          withheld: string[]
        }[]
        SetofOptions: {
          from: "*"
          to: "report_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      clear_station_message_template: {
        Args: {
          p_company_id: string
          p_key: Database["public"]["Enums"]["system_message_key"]
        }
        Returns: undefined
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
      consume_unsubscribe_token: {
        Args: { p_all_stations?: boolean; p_token_hash: string }
        Returns: {
          company_id: string
          consents_written: number
          member_id: string
        }[]
      }
      consume_widget_link: { Args: { p_code: string }; Returns: Json }
      country_alpha2: { Args: { p_input: string }; Returns: string }
      country_phone_rule: {
        Args: { p_alpha2: string }
        Returns: {
          calling_code: string
          national_max: number
          national_min: number
        }[]
      }
      create_album: {
        Args: {
          p_company_id: string
          p_cover_md5?: string
          p_deezer_album_id?: number
          p_legacy_id?: string
          p_release_date?: string
          p_title: string
          p_upc?: string
        }
        Returns: string
      }
      create_campaign: {
        Args: {
          p_addresses: Json
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_list_id: string
          p_member_ids: string[]
          p_template_id: string
          p_variables: Json
        }
        Returns: string
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
          p_country?: string
          p_cpf_hash?: string
          p_cpf_last_digits?: string
          p_discovery_source?: string
          p_email?: string
          p_first_contact_at?: string
          p_first_contact_origin?: string
          p_full_name: string
          p_gender?: string
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
      create_music_request: {
        Args: {
          p_company_id: string
          p_member_id: string
          p_requested_at?: string
          p_show_id?: string
          p_song_id: string
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
      create_promotion: {
        Args: {
          p_allow_multiple_entries?: boolean
          p_authorization_certificate?: string
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
          p_rules?: string
          p_show_id?: string
          p_site_integration_code?: number
          p_starts_at: string
          p_web_enabled?: boolean
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
      create_send_list: {
        Args: {
          p_company_id: string
          p_filters: Json
          p_kind: Database["public"]["Enums"]["send_list_kind"]
          p_member_ids: string[]
          p_name: string
          p_source: Database["public"]["Enums"]["send_list_source"]
        }
        Returns: string
      }
      create_song: {
        Args: {
          p_album_id?: string
          p_artist_id: string
          p_company_id: string
          p_duration_seconds?: number
          p_genre_id?: string
          p_internal_code?: string
          p_isrc?: string
          p_label_id?: string
          p_legacy_id?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_songwriter_id?: string
          p_title: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: string
      }
      create_song_from_deezer: {
        Args: {
          p_album_title?: string
          p_artist_name: string
          p_company_id: string
          p_cover_md5?: string
          p_deezer_album_id?: number
          p_deezer_track_id?: number
          p_duration_seconds?: number
          p_genre_name?: string
          p_isrc?: string
          p_label_name?: string
          p_release_date?: string
          p_songwriter_id?: string
          p_title: string
          p_upc?: string
        }
        Returns: string
      }
      delete_role: { Args: { p_role_id: string }; Returns: undefined }
      delete_send_list: { Args: { p_list_id: string }; Returns: undefined }
      deliver_prize: {
        Args: { p_note?: string; p_winner_id: string }
        Returns: undefined
      }
      disable_integration: {
        Args: { p_company_id: string }
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
      end_show: {
        Args: { p_ends_on: string; p_show_id: string }
        Returns: undefined
      }
      enqueue_artwork_erasure: {
        Args: { p_key: string; p_url: string }
        Returns: undefined
      }
      enqueue_missing_places: { Args: { p_limit?: number }; Returns: number }
      enqueue_pickup_reminder: {
        Args: { p_winner_id: string }
        Returns: string
      }
      enqueue_place: {
        Args: {
          p_city: string
          p_country: string
          p_neighbourhood: string
          p_place_key: string
          p_state: string
        }
        Returns: string
      }
      enqueue_whatsapp_outbound: {
        Args: {
          p_body: string
          p_dedupe_key: string
          p_integration_id: string
          p_interactive: Json
          p_template_purpose?: Database["public"]["Enums"]["template_purpose"]
          p_template_variables?: Json
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
      fail_report_run: {
        Args: { p_error: string; p_run_id: string }
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
      finish_report_run: {
        Args: {
          p_byte_size: number
          p_row_count: number
          p_run_id: string
          p_storage_path: string
          p_withheld?: string[]
        }
        Returns: undefined
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
      gender_normalize: { Args: { p_input: string }; Returns: string }
      get_audience_dashboard: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      get_audience_geography: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      get_draw: { Args: { p_draw_id: string }; Returns: Json }
      get_integration: {
        Args: { p_company_id: string }
        Returns: {
          company_id: string
          company_name: string
          company_status: Database["public"]["Enums"]["company_status"]
          display_phone_number: string
          enabled: boolean
          integration_id: string
          organization_id: string
          organization_name: string
          phone_number_id: string
          updated_at: string
          waba_id: string
        }[]
      }
      get_music_dashboard: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      get_music_geography: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      get_promotions_dashboard: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      get_promotions_geography: {
        Args: {
          p_company_ids: string[]
          p_from?: string
          p_preset?: string
          p_to?: string
        }
        Returns: Json
      }
      has_company_access: { Args: { p_company_id: string }; Returns: boolean }
      has_company_access_for: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: boolean
      }
      has_no_duplicates: { Args: { p_values: unknown }; Returns: boolean }
      has_org_permission: {
        Args: { p_organization_id: string; p_permission: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_company_id: string; p_permission: string }
        Returns: boolean
      }
      has_permission_for: {
        Args: { p_company_id: string; p_permission: string; p_user_id: string }
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
      international_phone: {
        Args: { p_country: string; p_phone: string }
        Returns: string
      }
      is_company_member: { Args: { p_company_id: string }; Returns: boolean }
      is_member_blocked: {
        Args: { p_company_id: string; p_member_id: string }
        Returns: boolean
      }
      is_org_member: { Args: { p_organization_id: string }; Returns: boolean }
      is_owner: { Args: { p_organization_id: string }; Returns: boolean }
      is_owner_for: {
        Args: { p_organization_id: string; p_user_id: string }
        Returns: boolean
      }
      is_owner_including_blocked: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      is_owner_of_company: { Args: { p_company_id: string }; Returns: boolean }
      is_owner_of_company_for: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: boolean
      }
      is_platform_admin: { Args: never; Returns: boolean }
      is_platform_admin_for: { Args: { p_user_id: string }; Returns: boolean }
      issue_api_credential: {
        Args: {
          p_company_id: string
          p_expires_at?: string
          p_name: string
          p_scopes: string[]
          p_token_hash: string
          p_token_prefix: string
        }
        Returns: string
      }
      issue_unsubscribe_token: {
        Args: {
          p_campaign_label?: string
          p_company_id: string
          p_member_id: string
          p_token_hash: string
        }
        Returns: string
      }
      job_started: { Args: { p_job: string }; Returns: undefined }
      job_succeeded: {
        Args: { p_counters?: Json; p_job: string }
        Returns: undefined
      }
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
      link_song_to_deezer: {
        Args: {
          p_album_title?: string
          p_cover_md5?: string
          p_deezer_album_id?: number
          p_deezer_track_id: number
          p_isrc?: string
          p_release_date?: string
          p_song_id: string
          p_upc?: string
        }
        Returns: undefined
      }
      list_api_credentials: {
        Args: { p_company_id: string }
        Returns: {
          created_at: string
          expires_at: string
          id: string
          last_used_at: string
          name: string
          revoked_at: string
          scopes: string[]
          token_prefix: string
        }[]
      }
      list_api_credentials_for: {
        Args: { p_company_ids: string[] }
        Returns: {
          company_id: string
          created_at: string
          expires_at: string
          id: string
          last_used_at: string
          name: string
          revoked_at: string
          scopes: string[]
          token_prefix: string
        }[]
      }
      list_audit_logs: {
        Args: {
          p_action?: string
          p_actor_id?: string
          p_company_id?: string
          p_cursor_at?: string
          p_cursor_id?: number
          p_from?: string
          p_limit?: number
          p_succeeded?: boolean
          p_target_table?: string
          p_to?: string
        }
        Returns: {
          action: string
          actor_id: string
          actor_name: string
          company_id: string
          company_name: string
          created_at: string
          detail: Json
          id: number
          organization_id: string
          succeeded: boolean
          target_id: string
          target_table: string
          total_count: number
        }[]
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
      list_integrations: {
        Args: never
        Returns: {
          company_id: string
          company_name: string
          company_status: Database["public"]["Enums"]["company_status"]
          display_phone_number: string
          enabled: boolean
          integration_id: string
          organization_id: string
          organization_name: string
          phone_number_id: string
          updated_at: string
          waba_id: string
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
      list_merge_candidates: {
        Args: {
          p_company_id: string
          p_kind: Database["public"]["Enums"]["music_merge_kind"]
          p_limit?: number
          p_search?: string
        }
        Returns: {
          child_count: number
          id: string
          label: string
          legacy_id: string
          sub_label: string
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
          p_types?: Database["public"]["Enums"]["inventory_movement_type"][]
          p_walking_back?: boolean
        }
        Returns: {
          actor_id: string
          actor_name: string
          created_at: string
          from_bucket: Database["public"]["Enums"]["inventory_bucket"]
          invoice_number: string
          movement_id: string
          movement_type: Database["public"]["Enums"]["inventory_movement_type"]
          note: string
          prize_id: string
          prize_name: string
          promotion_archived: boolean
          promotion_id: string
          promotion_name: string
          quantity: number
          remaining_quantity: number
          reserved_for_show_id: string
          reversal_id: string
          reversed_at: string
          reverses_movement_id: string
          show_name: string
          to_bucket: Database["public"]["Enums"]["inventory_bucket"]
          total_amount: number
          total_count: number
          unit_amount: number
          vendor_id: string
          vendor_name: string
        }[]
      }
      list_music_requests: {
        Args: {
          p_channel?: Database["public"]["Enums"]["music_request_channel"]
          p_company_id: string
          p_cursor_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_play_status?: Database["public"]["Enums"]["music_request_play_status"]
          p_read_status?: Database["public"]["Enums"]["music_request_read_status"]
          p_search?: string
          p_show_id?: string
          p_song_id?: string
          p_sort?: string
          p_walking_back?: boolean
        }
        Returns: {
          artist_name: string
          cancelled_at: string
          channel: Database["public"]["Enums"]["music_request_channel"]
          listener_note: string
          member_id: string
          member_name: string
          member_phone_last4: string
          play_status: Database["public"]["Enums"]["music_request_play_status"]
          played_at: string
          read_at: string
          read_status: Database["public"]["Enums"]["music_request_read_status"]
          request_id: string
          requested_at: string
          show_id: string
          show_name: string
          song_archived: boolean
          song_id: string
          song_title: string
          total_count: number
        }[]
      }
      list_organizations: {
        Args: never
        Returns: {
          address_complement: string
          address_line: string
          address_number: string
          billing_entity: Database["public"]["Enums"]["billing_entity"]
          city: string
          created_at: string
          fiscal_email: string
          id: string
          legal_name: string
          municipal_registration: string
          name: string
          neighbourhood: string
          owner_email: string
          owner_user_id: string
          postal_code: string
          state: string
          station_count: number
          suspended_at: string
          suspension_reason: string
          tax_id: string
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
          listener_phone_last4: string
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
          member_phone_last4: string
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
      mark_music_request_played: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      mark_music_request_read: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      may_write_artwork: { Args: { p_name: string }; Returns: boolean }
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
      member_phone_last4: { Args: { p_phone: string }; Returns: string }
      member_place_key: {
        Args: {
          p_city: string
          p_country: string
          p_neighbourhood: string
          p_state: string
        }
        Returns: string
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
      members_marketing_eligible_bulk: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_member_ids: string[]
        }
        Returns: {
          eligible: boolean
          member_id: string
        }[]
      }
      members_marketing_eligible_bulk_for_worker: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_member_ids: string[]
        }
        Returns: {
          eligible: boolean
          member_id: string
        }[]
      }
      merge_artists: {
        Args: { p_loser_ids: string[]; p_reason: string; p_winner_id: string }
        Returns: number
      }
      merge_music_genres: {
        Args: { p_loser_ids: string[]; p_reason: string; p_winner_id: string }
        Returns: number
      }
      merge_record_labels: {
        Args: { p_loser_ids: string[]; p_reason: string; p_winner_id: string }
        Returns: number
      }
      merge_shows: {
        Args: { p_loser_ids: string[]; p_reason: string; p_winner_id: string }
        Returns: number
      }
      merge_songs: {
        Args: { p_loser_ids: string[]; p_reason: string; p_winner_id: string }
        Returns: number
      }
      mint_widget_link: {
        Args: {
          p_company_id: string
          p_member_id: string
          p_promotion_id?: string
          p_purpose: Database["public"]["Enums"]["widget_link_purpose"]
        }
        Returns: string
      }
      music_merge_table: {
        Args: { p_kind: Database["public"]["Enums"]["music_merge_kind"] }
        Returns: string
      }
      music_reference_table: {
        Args: { p_kind: Database["public"]["Enums"]["music_reference_kind"] }
        Returns: string
      }
      new_deletion_protocol: { Args: never; Returns: string }
      normalize_email: { Args: { p_email: string }; Returns: string }
      normalize_phone: { Args: { p_phone: string }; Returns: string }
      participation_status_for: {
        Args: { p_member_id: string; p_promotion_id: string; p_when: string }
        Returns: Database["public"]["Enums"]["participation_status"]
      }
      place_fold: { Args: { p_value: string }; Returns: string }
      project_promotion_prize_movement: {
        Args: {
          p_promotion_prize_id: string
          p_quantity: number
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
        }
        Returns: undefined
      }
      promotion_is_live: {
        Args: {
          p_at: string
          p_cancelled_at: string
          p_ends_at: string
          p_starts_at: string
        }
        Returns: boolean
      }
      promotion_participation_correctness: {
        Args: { p_promotion_id: string }
        Returns: {
          answered_correctly: boolean
          participation_id: string
        }[]
      }
      promotion_show_schedule: {
        Args: { p_promotion_id: string }
        Returns: {
          band: number
          ends_at: string
          show_id: string
          show_name: string
          starts_at: string
          weekday: number
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
      provision_organization: {
        Args: { p_organization_name: string; p_user_id: string }
        Returns: string
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
      record_campaign_test_send: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_destination: string
          p_list_id: string
          p_template_id: string
        }
        Returns: undefined
      }
      record_conversation_marketing_answer: {
        Args: {
          p_company_id: string
          p_granted: boolean
          p_member_id: string
          p_promotion_id?: string
        }
        Returns: string
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
      record_place_geocode: {
        Args: {
          p_failure_reason?: string
          p_id: string
          p_latitude?: number
          p_longitude?: number
          p_precision?: string
        }
        Returns: undefined
      }
      record_stock_entry: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_invoice_number?: string
          p_note?: string
          p_prize_id: string
          p_quantity: number
          p_total_amount?: number
          p_type: Database["public"]["Enums"]["inventory_movement_type"]
          p_unit_amount?: number
          p_vendor_id?: string
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
          p_type?: Database["public"]["Enums"]["inventory_movement_type"]
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
      register_message_template: {
        Args: {
          p_body: string
          p_company_id: string
          p_language: string
          p_name: string
          p_otp_button?: boolean
          p_purpose: Database["public"]["Enums"]["template_purpose"]
          p_variables?: Json
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
          p_reservation_id?: string
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
      rename_send_list: {
        Args: { p_list_id: string; p_name: string }
        Returns: undefined
      }
      reopen_pickup_deadline: {
        Args: { p_deadline_at: string; p_reason: string; p_winner_id: string }
        Returns: undefined
      }
      report_guard: {
        Args: {
          p_company_ids: string[]
          p_permission: string
          p_user_id: string
        }
        Returns: undefined
      }
      report_page: {
        Args: {
          p_company_ids: string[]
          p_cursor_at?: string
          p_cursor_id?: string
          p_filters: Json
          p_limit?: number
          p_report_type: Database["public"]["Enums"]["report_type"]
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      report_page_listeners: {
        Args: {
          p_company_ids: string[]
          p_cursor_at: string
          p_cursor_id: string
          p_filters: Json
          p_limit: number
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      report_page_movements: {
        Args: {
          p_company_ids: string[]
          p_cursor_at: string
          p_cursor_id: string
          p_filters: Json
          p_limit: number
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      report_page_music_requests: {
        Args: {
          p_company_ids: string[]
          p_cursor_at: string
          p_cursor_id: string
          p_filters: Json
          p_limit: number
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      report_page_participations: {
        Args: {
          p_company_ids: string[]
          p_cursor_at: string
          p_cursor_id: string
          p_filters: Json
          p_limit: number
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      report_page_winners: {
        Args: {
          p_company_ids: string[]
          p_cursor_at: string
          p_cursor_id: string
          p_filters: Json
          p_limit: number
          p_user_id: string
        }
        Returns: {
          row_data: Json
          sort_at: string
          sort_id: string
          total_count: number
          withheld: string[]
        }[]
      }
      request_report: {
        Args: {
          p_company_ids: string[]
          p_filters?: Json
          p_format: Database["public"]["Enums"]["report_format"]
          p_organization_id: string
          p_payload?: Json
          p_report_type: Database["public"]["Enums"]["report_type"]
        }
        Returns: string
      }
      requeue_stalled_report_runs: { Args: never; Returns: number }
      reserve_stock: {
        Args: {
          p_company_id: string
          p_idempotency_key?: string
          p_note: string
          p_prize_id: string
          p_quantity: number
          p_show_id?: string
        }
        Returns: string
      }
      reset_provisional_password: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      resolve_album_tracked: {
        Args: {
          p_company_id: string
          p_cover_md5: string
          p_deezer_album_id: number
          p_release_date: string
          p_title: string
          p_upc: string
        }
        Returns: Record<string, unknown>
      }
      resolve_dashboard_period: {
        Args: {
          p_from: string
          p_preset: string
          p_timezone: string
          p_to: string
        }
        Returns: {
          from_at: string
          from_date: string
          previous_from_at: string
          previous_from_date: string
          previous_to_at: string
          previous_to_date: string
          to_at: string
          to_date: string
        }[]
      }
      resolve_or_create_album: {
        Args: {
          p_company_id: string
          p_cover_md5: string
          p_deezer_album_id: number
          p_release_date: string
          p_title: string
          p_upc: string
        }
        Returns: string
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
      resolve_or_create_reference: {
        Args: {
          p_company_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
          p_name: string
        }
        Returns: string
      }
      resolve_reference_tracked: {
        Args: {
          p_company_id: string
          p_kind: Database["public"]["Enums"]["music_reference_kind"]
          p_name: string
        }
        Returns: Record<string, unknown>
      }
      return_prize: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
      return_promotion_prizes: {
        Args: { p_company_id: string; p_note: string; p_promotion_id: string }
        Returns: number
      }
      reveal_member_field: {
        Args: { p_field: string; p_member_id: string }
        Returns: string
      }
      reveal_request_phone: { Args: { p_request_id: string }; Returns: string }
      reverse_movement: {
        Args: { p_movement_id: string; p_note: string }
        Returns: string
      }
      revoke_api_credential: {
        Args: { p_credential_id: string }
        Returns: undefined
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
      save_marketing_template: {
        Args: {
          p_body: string
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_company_id: string
          p_description?: string
          p_from_email?: string
          p_from_name?: string
          p_id?: string
          p_internal_name: string
          p_language?: string
          p_name?: string
          p_reply_to?: string
          p_subject?: string
          p_variables?: Json
        }
        Returns: string
      }
      save_prize_category: {
        Args: { p_category_id?: string; p_company_id: string; p_name: string }
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
      save_show: {
        Args: {
          p_age_rating: Database["public"]["Enums"]["show_age_rating"]
          p_bands: Json
          p_company_id: string
          p_ends_on?: string
          p_kind: Database["public"]["Enums"]["show_kind"]
          p_name: string
          p_presenter_name?: string
          p_producer_name?: string
          p_show_id?: string
          p_starts_on: string
        }
        Returns: string
      }
      save_song_integration: {
        Args: {
          p_artist?: string
          p_category?: string
          p_code: string
          p_company_id: string
          p_title?: string
        }
        Returns: string
      }
      save_station_email_identity: {
        Args: {
          p_company_id: string
          p_from_address?: string
          p_from_name?: string
          p_reply_to?: string
        }
        Returns: undefined
      }
      save_vendor: {
        Args: {
          p_address_line?: string
          p_city?: string
          p_company_id: string
          p_contact_name?: string
          p_document?: string
          p_email?: string
          p_legal_name?: string
          p_name: string
          p_notes?: string
          p_phone?: string
          p_postal_code?: string
          p_state?: string
          p_vendor_id?: string
          p_website?: string
        }
        Returns: string
      }
      send_list_member_ids: { Args: { p_list_id: string }; Returns: string[] }
      service_hashtags_for: { Args: { p_company_id: string }; Returns: Json }
      set_album_cover: {
        Args: { p_album_id: string; p_url?: string }
        Returns: undefined
      }
      set_company_thumb: {
        Args: { p_company_id: string; p_url?: string }
        Returns: undefined
      }
      set_listener_locale: {
        Args: { p_company_id: string; p_locale: string }
        Returns: undefined
      }
      set_prize_photo: {
        Args: { p_prize_id: string; p_url?: string }
        Returns: undefined
      }
      set_promotion_art: {
        Args: { p_promotion_id: string; p_url?: string }
        Returns: undefined
      }
      set_promotion_thumb: {
        Args: { p_promotion_id: string; p_url?: string }
        Returns: undefined
      }
      set_question_moderation_guidelines: {
        Args: { p_guidelines?: string; p_question_id: string }
        Returns: undefined
      }
      set_service_hashtags: {
        Args: { p_company_id: string; p_music: string; p_service: string }
        Returns: undefined
      }
      set_song_integration_code: {
        Args: { p_code?: string; p_song_id: string }
        Returns: undefined
      }
      set_station_message_template: {
        Args: {
          p_body: string
          p_company_id: string
          p_key: Database["public"]["Enums"]["system_message_key"]
        }
        Returns: string
      }
      shares_organization_with: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      shows_on_air: { Args: { p_company_id: string }; Returns: string[] }
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
      station_whatsapp_status: {
        Args: { p_company_id: string }
        Returns: {
          connected: boolean
          display_phone_number: string
          enabled: boolean
          updated_at: string
        }[]
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
      unblock_organization: {
        Args: { p_organization_id: string }
        Returns: undefined
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
      unlink_song_from_deezer: {
        Args: { p_song_id: string }
        Returns: undefined
      }
      update_album: {
        Args: {
          p_album_id: string
          p_release_date: string
          p_title: string
          p_upc: string
        }
        Returns: undefined
      }
      update_company_profile: {
        Args: {
          p_address_complement?: string
          p_address_line?: string
          p_address_number?: string
          p_broadcast_band?: Database["public"]["Enums"]["broadcast_band"]
          p_city?: string
          p_company_id: string
          p_contact_email?: string
          p_contact_phone?: string
          p_country?: string
          p_description?: string
          p_facebook_url?: string
          p_fiscal_email?: string
          p_frequency_khz?: number
          p_instagram_url?: string
          p_latitude?: number
          p_legal_name?: string
          p_longitude?: number
          p_municipal_registration?: string
          p_neighbourhood?: string
          p_postal_code?: string
          p_state?: string
          p_tagline?: string
          p_tax_id?: string
          p_website_url?: string
          p_youtube_url?: string
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
          p_country?: string
          p_cpf_hash?: string
          p_cpf_last_digits?: string
          p_discovery_source?: string
          p_email?: string
          p_full_name: string
          p_gender?: string
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
      update_organization: {
        Args: {
          p_address_complement?: string
          p_address_line?: string
          p_address_number?: string
          p_billing_entity?: Database["public"]["Enums"]["billing_entity"]
          p_city?: string
          p_fiscal_email?: string
          p_legal_name?: string
          p_municipal_registration?: string
          p_name: string
          p_neighbourhood?: string
          p_organization_id: string
          p_postal_code?: string
          p_state?: string
          p_tax_id?: string
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
          p_authorization_certificate?: string
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
          p_rules?: string
          p_show_id?: string
          p_site_integration_code?: number
          p_starts_at: string
          p_web_enabled?: boolean
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
          p_album_id?: string
          p_artist_id: string
          p_duration_seconds?: number
          p_genre_id?: string
          p_isrc?: string
          p_label_id?: string
          p_nationality?: Database["public"]["Enums"]["music_nationality"]
          p_song_id: string
          p_songwriter_id?: string
          p_title: string
          p_vocal?: Database["public"]["Enums"]["music_vocal"]
        }
        Returns: undefined
      }
      upsert_integration: {
        Args: {
          p_company_id: string
          p_display_phone_number?: string
          p_enabled?: boolean
          p_phone_number_id: string
          p_waba_id?: string
        }
        Returns: string
      }
      upsert_widget_installation: {
        Args: {
          p_allowed_origins: string[]
          p_company_id: string
          p_enabled: boolean
          p_music_request_cooldown?: string
          p_public_key: string
        }
        Returns: string
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
      whatsapp_reply_envelope: {
        Args: {
          p_company_id: string
          p_member_id: string
          p_promotion_id: string
          p_status: string
        }
        Returns: Json
      }
      widget_enter_promotion: {
        Args: {
          p_answers?: Json
          p_consent: boolean
          p_fields?: Json
          p_marketing_consent?: boolean
          p_member_id: string
          p_promotion_id: string
          p_public_key: string
        }
        Returns: Json
      }
      widget_frame_context: { Args: { p_public_key: string }; Returns: Json }
      widget_installation_for: { Args: { p_company_id: string }; Returns: Json }
      widget_link_send_context: {
        Args: { p_company_id: string }
        Returns: Json
      }
      widget_listener_context: {
        Args: { p_member_id: string; p_public_key: string }
        Returns: Record<string, unknown>
      }
      widget_music_request_context: {
        Args: { p_member_id: string; p_public_key: string }
        Returns: Record<string, unknown>
      }
      widget_music_request_wait: {
        Args: { p_member_id: string; p_public_key: string }
        Returns: Json
      }
      widget_promotions: {
        Args: { p_member_id: string; p_public_key: string }
        Returns: Json
      }
      widget_record_music_request: {
        Args: {
          p_album_title?: string
          p_artist_name: string
          p_cover_md5?: string
          p_deezer_album_id?: number
          p_deezer_track_id: number
          p_duration_seconds?: number
          p_genre_name?: string
          p_isrc?: string
          p_label_name?: string
          p_member_id: string
          p_note?: string
          p_public_key: string
          p_release_date?: string
          p_show_id?: string
          p_title: string
          p_upc?: string
        }
        Returns: Json
      }
      widget_request_code: {
        Args: {
          p_code_hash: string
          p_code_plain: string
          p_phone: string
          p_public_key: string
          p_ttl_seconds?: number
        }
        Returns: Json
      }
      widget_shows: {
        Args: { p_member_id: string; p_public_key: string }
        Returns: Json
      }
      widget_station_identity: { Args: { p_public_key: string }; Returns: Json }
      widget_verify_code: {
        Args: {
          p_code_hash: string
          p_name?: string
          p_phone: string
          p_public_key: string
        }
        Returns: Json
      }
      withdraw_marketing_by_phone: {
        Args: { p_integration_id: string; p_phone: string }
        Returns: string
      }
      write_off_prize: {
        Args: { p_reason: string; p_winner_id: string }
        Returns: undefined
      }
    }
    Enums: {
      billing_entity: "ORGANIZATION" | "STATIONS"
      broadcast_band: "FM" | "AM" | "WEB"
      campaign_recipient_status:
        | "pending"
        | "claimed"
        | "sent"
        | "failed"
        | "suppressed"
        | "cancelled"
      campaign_status: "queued" | "running" | "sent" | "failed" | "cancelled"
      company_status: "active" | "suspended"
      contact_request_status: "new" | "contacted" | "converted" | "discarded"
      data_deletion_request_status:
        | "new"
        | "verifying"
        | "completed"
        | "refused"
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
        | "BARTER_ENTRY"
        | "TRANSFER_EXIT"
      invitation_status: "pending" | "accepted" | "revoked"
      member_block_kind: "draw_ban" | "suspension"
      member_consent_type:
        | "rules"
        | "image_use"
        | "sponsor_communication"
        | "whatsapp_marketing"
        | "email_marketing"
        | "identification"
      member_erasure_reason:
        | "subject_request"
        | "court_order"
        | "internal_policy"
      message_channel: "WHATSAPP" | "EMAIL"
      music_merge_kind: "SONG" | "ARTIST" | "LABEL" | "GENRE" | "SHOW"
      music_nationality: "DOMESTIC" | "INTERNATIONAL"
      music_reference_kind: "GENRE" | "LABEL" | "ARTIST" | "SHOW" | "SONGWRITER"
      music_request_channel: "MANUAL" | "IMPORT" | "API" | "WEB"
      music_request_play_status: "NOT_PLAYED" | "PLAYED" | "CANCELLED"
      music_request_read_status: "UNREAD" | "READ" | "CANCELLED"
      music_vocal: "MALE" | "FEMALE" | "DUO" | "GROUP" | "INSTRUMENTAL"
      org_role: "owner" | "member"
      outbox_status: "PENDING" | "SENDING" | "SENT" | "FAILED"
      participation_source: "MANUAL" | "IMPORT" | "WHATSAPP" | "WEB"
      participation_status: "VALID" | "DUPLICATE" | "TOO_SOON" | "OVER_LIMIT"
      permission_scope: "organization" | "company"
      promotion_question_kind: "QUIZ" | "MULTIPLE_CHOICE" | "ESSAY"
      promotion_requested_field:
        | "full_name"
        | "address"
        | "city"
        | "neighbourhood"
        | "age"
        | "gender"
        | "cpf"
        | "passport"
        | "discovery_source"
        | "country"
      report_format: "CSV" | "XLSX" | "PDF"
      report_status: "QUEUED" | "RUNNING" | "READY" | "FAILED"
      report_type:
        | "LISTENERS"
        | "PARTICIPATIONS"
        | "WINNERS"
        | "MUSIC_REQUESTS"
        | "MOVEMENTS"
        | "AUDIENCE_PANEL"
        | "MUSIC_PANEL"
        | "PROMOTIONS_PANEL"
      send_list_kind: "fixed" | "living"
      send_list_source: "members" | "participations" | "requests"
      show_age_rating: "L" | "10" | "12" | "14" | "16" | "18"
      show_kind: "MUSICAL" | "NEWS" | "TALK_SHOW" | "SPORTS" | "ENTERTAINMENT"
      system_message_key:
        | "REFUSAL"
        | "ABANDON"
        | "FULL_NAME"
        | "ADDRESS"
        | "CITY"
        | "NEIGHBOURHOOD"
        | "AGE"
        | "GENDER"
        | "CPF"
        | "PASSPORT"
        | "DISCOVERY_SOURCE"
        | "LINK_MUSIC"
        | "LINK_MENU"
        | "LINK_PROMOTION"
        | "COUNTRY"
        | "MARKETING_CONSENT"
        | "MARKETING_STOPPED"
      template_purpose:
        | "PICKUP_REMINDER"
        | "WEB_VERIFICATION"
        | "PARTICIPATION_CONFIRMED"
        | "PARTICIPATION_DUPLICATE"
        | "PARTICIPATION_TOO_SOON"
        | "PARTICIPATION_OVER_LIMIT"
      template_variable:
        | "LISTENER_FIRST_NAME"
        | "LISTENER_FULL_NAME"
        | "LISTENER_CITY"
        | "STATION_NAME"
        | "PRIZE_NAME"
        | "PICKUP_DEADLINE"
        | "VERIFICATION_CODE"
      webhook_event_status: "RECEIVED" | "PROCESSING" | "DONE" | "FAILED"
      widget_link_purpose: "MUSIC" | "MENU" | "PROMOTION"
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
      billing_entity: ["ORGANIZATION", "STATIONS"],
      broadcast_band: ["FM", "AM", "WEB"],
      campaign_recipient_status: [
        "pending",
        "claimed",
        "sent",
        "failed",
        "suppressed",
        "cancelled",
      ],
      campaign_status: ["queued", "running", "sent", "failed", "cancelled"],
      company_status: ["active", "suspended"],
      contact_request_status: ["new", "contacted", "converted", "discarded"],
      data_deletion_request_status: [
        "new",
        "verifying",
        "completed",
        "refused",
      ],
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
        "BARTER_ENTRY",
        "TRANSFER_EXIT",
      ],
      invitation_status: ["pending", "accepted", "revoked"],
      member_block_kind: ["draw_ban", "suspension"],
      member_consent_type: [
        "rules",
        "image_use",
        "sponsor_communication",
        "whatsapp_marketing",
        "email_marketing",
        "identification",
      ],
      member_erasure_reason: [
        "subject_request",
        "court_order",
        "internal_policy",
      ],
      message_channel: ["WHATSAPP", "EMAIL"],
      music_merge_kind: ["SONG", "ARTIST", "LABEL", "GENRE", "SHOW"],
      music_nationality: ["DOMESTIC", "INTERNATIONAL"],
      music_reference_kind: ["GENRE", "LABEL", "ARTIST", "SHOW", "SONGWRITER"],
      music_request_channel: ["MANUAL", "IMPORT", "API", "WEB"],
      music_request_play_status: ["NOT_PLAYED", "PLAYED", "CANCELLED"],
      music_request_read_status: ["UNREAD", "READ", "CANCELLED"],
      music_vocal: ["MALE", "FEMALE", "DUO", "GROUP", "INSTRUMENTAL"],
      org_role: ["owner", "member"],
      outbox_status: ["PENDING", "SENDING", "SENT", "FAILED"],
      participation_source: ["MANUAL", "IMPORT", "WHATSAPP", "WEB"],
      participation_status: ["VALID", "DUPLICATE", "TOO_SOON", "OVER_LIMIT"],
      permission_scope: ["organization", "company"],
      promotion_question_kind: ["QUIZ", "MULTIPLE_CHOICE", "ESSAY"],
      promotion_requested_field: [
        "full_name",
        "address",
        "city",
        "neighbourhood",
        "age",
        "gender",
        "cpf",
        "passport",
        "discovery_source",
        "country",
      ],
      report_format: ["CSV", "XLSX", "PDF"],
      report_status: ["QUEUED", "RUNNING", "READY", "FAILED"],
      report_type: [
        "LISTENERS",
        "PARTICIPATIONS",
        "WINNERS",
        "MUSIC_REQUESTS",
        "MOVEMENTS",
        "AUDIENCE_PANEL",
        "MUSIC_PANEL",
        "PROMOTIONS_PANEL",
      ],
      send_list_kind: ["fixed", "living"],
      send_list_source: ["members", "participations", "requests"],
      show_age_rating: ["L", "10", "12", "14", "16", "18"],
      show_kind: ["MUSICAL", "NEWS", "TALK_SHOW", "SPORTS", "ENTERTAINMENT"],
      system_message_key: [
        "REFUSAL",
        "ABANDON",
        "FULL_NAME",
        "ADDRESS",
        "CITY",
        "NEIGHBOURHOOD",
        "AGE",
        "GENDER",
        "CPF",
        "PASSPORT",
        "DISCOVERY_SOURCE",
        "LINK_MUSIC",
        "LINK_MENU",
        "LINK_PROMOTION",
        "COUNTRY",
        "MARKETING_CONSENT",
        "MARKETING_STOPPED",
      ],
      template_purpose: [
        "PICKUP_REMINDER",
        "WEB_VERIFICATION",
        "PARTICIPATION_CONFIRMED",
        "PARTICIPATION_DUPLICATE",
        "PARTICIPATION_TOO_SOON",
        "PARTICIPATION_OVER_LIMIT",
      ],
      template_variable: [
        "LISTENER_FIRST_NAME",
        "LISTENER_FULL_NAME",
        "LISTENER_CITY",
        "STATION_NAME",
        "PRIZE_NAME",
        "PICKUP_DEADLINE",
        "VERIFICATION_CODE",
      ],
      webhook_event_status: ["RECEIVED", "PROCESSING", "DONE", "FAILED"],
      widget_link_purpose: ["MUSIC", "MENU", "PROMOTION"],
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

