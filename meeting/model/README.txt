Speech engine for Morning Meeting: NVIDIA parakeet-tdt_ctc-110m (transducer branch), int8 ONNX export
by the sherpa-onnx project (k2-fsa). Licensed CC-BY-4.0 by NVIDIA. The encoder is split into parts
because GitHub refuses files over 100 MB; the app joins them back together.
mel80.bin is the 80-band Slaney mel filterbank (16 kHz, 512-point FFT) used to prepare the audio.
