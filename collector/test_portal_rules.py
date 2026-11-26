from test_processing import article, CONFIG
from process_content import classify_rules

def test_announcement_exploring_how_is_news_not_a_tutorial():
    label = classify_rules(article('a', '铠侠与英伟达合作，探索如何将 GPU 有效显存扩展至 PB 级', '宣布启动GPU概念验证，GPU内存研究。'), CONFIG)
    assert label['content_type'] == 'news'
    assert label['technology_relevance'] == 'relevant'

def test_generic_scientific_research_does_not_imply_computing():
    label = classify_rules(article('a', '研究人员首次发现宇宙中性氢信号', '研究宇宙，研究天文学。'), CONFIG)
    assert label['technology_relevance'] == 'uncertain'
    assert label['status'] == 'needs_review'
    ai = classify_rules(article('b', 'AI辅助数学证明取得新进展', 'AI与形式化计算研究。'), CONFIG)
    assert ai['technology_relevance'] == 'relevant' and 'ai_science' in ai['topics']

def test_desktop_hardware_is_in_scope_without_ai_or_programming():
    label = classify_rules(article('a', '新款显示器发布，主板与固态硬盘完成适配', '显示器连接主板，显示器配套固态硬盘。'), CONFIG)
    assert label['technology_relevance'] == 'relevant' and 'hardware' in label['topics']
