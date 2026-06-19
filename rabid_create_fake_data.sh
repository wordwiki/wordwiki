#!/bin/bash
# Rebuild the on-disk db with fake data for a scenario (default: dev).
#   ./rabid_create_fake_data.sh            # dev: people/events/commitments, NO bulk timesheets
#   ./rabid_create_fake_data.sh activityReport   # everything, incl. the bulk timesheet set
#   ./rabid_create_fake_data.sh minimal|dev|full|activityReport
set -e
SCENARIO="${1:-dev}"
deno run -A --check rabid/fake_data.ts destroy_all_and_fill_with_fake_data "$SCENARIO"
