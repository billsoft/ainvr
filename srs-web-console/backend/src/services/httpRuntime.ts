// Use the locked upstream HTTP implementation, not Node's bundled 7.29 parser.
// nodejs/undici#5474 fixes socket FIN while a response is paused by backpressure.
// Install matching fetch/Response/Headers classes together; never swallow a
// process-wide uncaught assertion and continue with corrupted request state.
import { install } from 'undici';
install();
