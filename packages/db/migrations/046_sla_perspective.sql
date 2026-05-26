-- 046_sla_perspective.sql
-- ============================================================
-- Add the `sla` perspective kind and seed the built-in Service
-- Levels perspective used by the SLA template.
--
-- The perspective renders an agreement-control surface: Rules as SLA
-- commitments, Evals as verification snapshots, References as source
-- documents / dashboards, Principals as owners, Decisions as change
-- history, and Actions as breach / claim response playbooks. It does
-- not store service-delivery events; Logs and telemetry stay in their
-- source systems and are referenced from the SLA Doco when needed.
-- ============================================================

ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph', 'list', 'bpmn', 'org-tree', 'sla'));

INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config)
VALUES
  ('perspective_sla',
   'sla',
   'sla',
   'SLAs',
   'Service-level agreement control plane — commitments, owners, evidence links, remedies, and review gaps.',
   '📜',
   NULL,
   true,
   '{"primary_entity":"rule","evidence_sources":["eval","reference"],"event_logs":false}'::jsonb)
ON CONFLICT (id) DO NOTHING;
