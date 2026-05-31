import unittest

from fastapi.testclient import TestClient

from services.recommendation import main as reco_main
from services.recommendation.db import get_candidate_source_table, get_items_by_city


class RecommendationMainTableFixTest(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_rerank = reco_main.rerank_candidates
        self._orig_mix = reco_main.compute_mix_policy

        def _stub_rerank(recall_results, user_id, user_city, user_tags):
            cz = [
                {
                    "id": item["id"],
                    "city": item["city"],
                    "title": item["title"],
                    "tags": item["tags"],
                    "excellence": item["excellence"],
                    "score_CZ": 1.0,
                }
                for item in recall_results["cz_candidates"][:10]
            ]
            ez = [
                {
                    "id": item["id"],
                    "city": item["city"],
                    "title": item["title"],
                    "tags": item["tags"],
                    "excellence": item["excellence"],
                    "score_EZ": 1.0,
                }
                for item in recall_results["ez_candidates"][:5]
            ]
            return {
                "cz_ranked": cz,
                "ez_ranked": ez,
                "stats": {
                    "ez_diversity_enabled": False,
                    "ez_diversity_method": "none",
                    "ez_lambda_diversity": 0.0,
                    "embedding_ok_count": 0,
                    "embedding_fail_count": 0,
                    "embedding_last_error": None,
                    "embedding_space": "none",
                    "embedding_space_counts": {"tes_v2": 0, "tes_v1_fallback": 0, "none": 0},
                    "embedding_fallback_reason": None,
                },
                "decision_trace": {"rule_id": "stub_rerank"},
            }

        def _stub_mix(cz_ranked, ez_ranked, intent=None, memory_confidence=None):
            return {
                "ratio": "1:1",
                "rule": "stub_mix",
                "confidence": 0.0,
                "inputs_used": {"intent": intent or "balanced", "memory_confidence": memory_confidence},
                "decision_trace": {"rule_id": "stub_mix"},
            }

        reco_main.rerank_candidates = _stub_rerank
        reco_main.compute_mix_policy = _stub_mix
        self.client = TestClient(reco_main.app)

    def tearDown(self) -> None:
        reco_main.rerank_candidates = self._orig_rerank
        reco_main.compute_mix_policy = self._orig_mix

    def test_city_coverage_and_source_table(self):
        self.assertEqual(get_candidate_source_table(), "reco_items")

        for city in ("tokyo", "barcelona", "guangzhou"):
            items = get_items_by_city(city)
            self.assertGreater(len(items), 0, f"expected candidates for city={city}")

            resp = self.client.post(
                "/score",
                json={
                    "data": {
                        "user_id": "reco_table_fix_test",
                        "city": city,
                        "tags": ["food"],
                    }
                },
            )
            self.assertEqual(resp.status_code, 200, f"/score failed for city={city}")
            body = resp.json()
            self.assertEqual(body["debug"]["candidate_source_table"], "reco_items")
            self.assertGreater(
                body["recall"]["total_candidates"],
                0,
                f"expected non-empty recall for city={city}",
            )


if __name__ == "__main__":
    unittest.main()
