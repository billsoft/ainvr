import pytest
import observability as ob

def fixture(bpu=30, used=50, total=100):
    return f'''cma_reserved heap total size {total}
allocations (info is from last known client):
client pid tgid type size kmap_cnt label shareid paddr
llm 1 1 bpu {bpu} 0 hbm 1 abc
video 2 2 vpu 20 0 no-label 2 def
total orphaned 0
total {used}
'''

def test_pool_and_bpu_are_distinct():
    assert ob.parse_ion_memory(fixture()) == dict(bpuMemoryBytes=30, ionMemoryBytes=50, ionMemoryTotalBytes=100)

def test_zero_is_valid():
    assert ob.parse_ion_memory(fixture(0,0))['bpuMemoryBytes'] == 0

@pytest.mark.parametrize('text', ['', 'total 0', fixture(60,50), fixture(30,150), fixture(0,0,0)])
def test_invalid_is_not_zero(text):
    with pytest.raises(ValueError):
        ob.parse_ion_memory(text)

def test_unavailable(monkeypatch):
    def fail(*args, **kwargs):
        raise PermissionError()
    monkeypatch.setattr(ob.Path, 'read_text', fail)
    assert all(v is None for v in ob.ion_memory().values())


def test_multiple_heaps_include_carveout_and_cma():
    text = ('the heap id is 6\n' + fixture(30,50,100)
            + 'the heap id is 2\n' + fixture(20,40,60).replace('cma_reserved', 'carveout')
            + 'the heap id is 4\n' + fixture(0,0,10).replace('cma_reserved', 'ion_cma')
            + 'the heap id is 0\n' + fixture(0,0,0).replace('cma_reserved', 'system'))
    assert ob.parse_ion_memory(text) == dict(bpuMemoryBytes=50, ionMemoryBytes=90, ionMemoryTotalBytes=170)

def test_incomplete_pool_does_not_report_partial_total():
    with pytest.raises(ValueError):
        ob.parse_ion_memory('the heap id is 6\n' + fixture() + 'the heap id is 2\ncarveout heap total size 100\n')
