"""Cross-language lifecycle lock tests; no hardware allocations."""
import sys,subprocess,tempfile,json,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service/runtime'))
from large_model_reservation import LargeModelReservation,ReservedExecutor
probe=sys.argv[1] if len(sys.argv)>1 else '/mnt/ainvr-ssd/llm-build/reservation_probe'
with tempfile.TemporaryDirectory() as tmp:
 def start():
  p=subprocess.Popen([probe,tmp],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  assert p.stdout.readline().strip()=='locked';return p
 def rejected():
  p=subprocess.run([probe,tmp],input='',capture_output=True,text=True);assert p.returncode==2
 a=LargeModelReservation(tmp);rejected();a.close()
 p=start()
 try:
  try:LargeModelReservation(tmp)
  except RuntimeError as e:assert str(e)=='large_model_busy'
  else:raise AssertionError('concurrent model admitted')
 finally:p.communicate('done\n',timeout=5)
 a=LargeModelReservation(tmp);a.loaded();a.close()
 p=start();p.kill();p.wait();a=LargeModelReservation(tmp);a.close()
 assert subprocess.run([probe,tmp,'insufficient'],capture_output=True).returncode==2
 a=LargeModelReservation(tmp);a.close()
 Path(tmp,'bpu-reservations.json').write_text('{invalid')
 rejected()
 try:LargeModelReservation(tmp)
 except json.JSONDecodeError:pass
 else:raise AssertionError('corruption ignored')
 Path(tmp,'bpu-reservations.json').write_text('{"holders":[]}')
 a=LargeModelReservation(tmp)
 class Broken:
  def close(self):raise RuntimeError('cleanup failed')
 wrapper=ReservedExecutor(Broken(),a)
 try:wrapper.close()
 except RuntimeError:pass
 rejected();a.close()
 print('PASS: bidirectional exclusion, release, crash recovery, budget, corruption, failed cleanup')
