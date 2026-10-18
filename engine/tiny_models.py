"""
TEST-ONLY tiny pipelines with random weights.

These are built from the same diffusers pipeline classes the real models use
(WanPipeline, LTXPipeline, LTXImageToVideoPipeline, CogVideoXPipeline,
AnimateDiffPipeline) but with tiny dimensions, so the engine's generation path
can be exercised in automated tests without downloading multi-GB weights. The
output is noise. They are only reachable when VOIDCRAFT_ENGINE_TEST=1 and never
appear in the app.
"""
import json
import os
import tempfile

_BASE = {"fullVramGB": 0, "minVramGB": 0, "negativePrompt": True, "repos": [], "license": "test", "notes": "test only"}

CATALOG = {
    "test-tiny-wan": {**_BASE, "id": "test-tiny-wan", "name": "Tiny Wan (test)", "pipeline": "wan", "tasks": ["text-to-video"], "fps": 16, "frameRule": {"multiple": 4, "offset": 1, "max": 9}, "durations": [1], "sizes": {"16:9": [32, 16], "9:16": [16, 32], "1:1": [16, 16]}, "steps": {"fast": 2, "standard": 2, "high": 3}, "guidance": 5.0},
    "test-tiny-ltx": {**_BASE, "id": "test-tiny-ltx", "name": "Tiny LTX (test)", "pipeline": "ltx", "tasks": ["text-to-video", "image-to-video"], "fps": 24, "frameRule": {"multiple": 8, "offset": 1, "max": 9}, "durations": [1], "sizes": {"16:9": [64, 32], "9:16": [32, 64], "1:1": [32, 32]}, "steps": {"fast": 2, "standard": 2, "high": 3}, "guidance": 3.0},
    "test-tiny-cogvideox": {**_BASE, "id": "test-tiny-cogvideox", "name": "Tiny CogVideoX (test)", "pipeline": "cogvideox", "tasks": ["text-to-video"], "fps": 8, "frameRule": {"fixed": 9}, "durations": [1], "sizes": {"16:9": [16, 16]}, "steps": {"fast": 2, "standard": 2, "high": 3}, "guidance": 6.0},
    "test-tiny-animatediff": {**_BASE, "id": "test-tiny-animatediff", "name": "Tiny AnimateDiff (test)", "pipeline": "animatediff", "tasks": ["text-to-video", "video-to-video"], "fps": 8, "frameRule": {"fixed": 8}, "durations": [1], "sizes": {"16:9": [64, 64]}, "steps": {"fast": 2, "standard": 2, "high": 2}, "guidance": 1.0},
}


def _t5(torch):
    from tokenizers import Tokenizer, models, pre_tokenizers, decoders
    from transformers import T5Config, T5EncoderModel, T5TokenizerFast

    vocab = [("<pad>", 0.0), ("</s>", 0.0), ("<unk>", 0.0), ("▁", -1.0)] + [(chr(c), -2.0) for c in range(33, 127)]
    tok = Tokenizer(models.Unigram(vocab, unk_id=2))
    tok.pre_tokenizer = pre_tokenizers.Metaspace()
    tok.decoder = decoders.Metaspace()
    tokenizer = T5TokenizerFast(tokenizer_object=tok, eos_token="</s>", pad_token="<pad>", unk_token="<unk>", extra_ids=0)
    torch.manual_seed(0)
    enc = T5EncoderModel(T5Config(vocab_size=len(vocab), d_model=32, d_kv=8, d_ff=37, num_layers=2, num_heads=4, relative_attention_num_buckets=8))
    return tokenizer, enc


def _bytes_to_unicode():
    # GPT-2/CLIP byte-level BPE alphabet.
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


def _clip(torch):
    from transformers import CLIPTextConfig, CLIPTextModel, CLIPTokenizer

    chars = list(_bytes_to_unicode().values())
    vocab = {c: i for i, c in enumerate(chars)}
    for c in chars:
        vocab[c + "</w>"] = len(vocab)
    vocab["<|startoftext|>"] = len(vocab)
    vocab["<|endoftext|>"] = len(vocab)
    d = tempfile.mkdtemp(prefix="vc-tiny-clip-")
    with open(os.path.join(d, "vocab.json"), "w", encoding="utf-8") as f:
        json.dump(vocab, f)
    with open(os.path.join(d, "merges.txt"), "w", encoding="utf-8") as f:
        f.write("#version: 0.2\n")
    tokenizer = CLIPTokenizer(os.path.join(d, "vocab.json"), os.path.join(d, "merges.txt"), model_max_length=77)
    torch.manual_seed(0)
    enc = CLIPTextModel(CLIPTextConfig(bos_token_id=vocab["<|startoftext|>"], eos_token_id=vocab["<|endoftext|>"], hidden_size=32, intermediate_size=37, num_attention_heads=4, num_hidden_layers=2, pad_token_id=vocab["<|endoftext|>"], vocab_size=len(vocab)))
    return tokenizer, enc


def build(model, torch, task="text-to-video"):
    import diffusers as D

    torch.manual_seed(0)
    kind = model["pipeline"]
    if kind == "wan":
        tok, enc = _t5(torch)
        vae = D.AutoencoderKLWan(base_dim=3, z_dim=16, dim_mult=[1, 1, 1, 1], num_res_blocks=1, temperal_downsample=[False, True, True])
        transformer = D.WanTransformer3DModel(patch_size=(1, 2, 2), num_attention_heads=2, attention_head_dim=12, in_channels=16, out_channels=16, text_dim=32, freq_dim=256, ffn_dim=32, num_layers=2, cross_attn_norm=True, qk_norm="rms_norm_across_heads", rope_max_seq_len=32)
        return D.WanPipeline(tokenizer=tok, text_encoder=enc, vae=vae, transformer=transformer, scheduler=D.FlowMatchEulerDiscreteScheduler(shift=7.0))
    if kind == "ltx":
        tok, enc = _t5(torch)
        transformer = D.LTXVideoTransformer3DModel(in_channels=8, out_channels=8, patch_size=1, patch_size_t=1, num_attention_heads=4, attention_head_dim=8, cross_attention_dim=32, num_layers=1, caption_channels=32)
        vae = D.AutoencoderKLLTXVideo(
            in_channels=3, out_channels=3, latent_channels=8, block_out_channels=(8, 8, 8, 8), decoder_block_out_channels=(8, 8, 8, 8),
            layers_per_block=(1, 1, 1, 1, 1), decoder_layers_per_block=(1, 1, 1, 1, 1), spatio_temporal_scaling=(True, True, False, False),
            decoder_spatio_temporal_scaling=(True, True, False, False), decoder_inject_noise=(False, False, False, False, False),
            upsample_residual=(False, False, False, False), upsample_factor=(1, 1, 1, 1), timestep_conditioning=False, patch_size=1, patch_size_t=1,
            encoder_causal=True, decoder_causal=False,
        )
        vae.use_framewise_encoding = False
        vae.use_framewise_decoding = False
        cls = D.LTXImageToVideoPipeline if task == "image-to-video" else D.LTXPipeline
        return cls(tokenizer=tok, text_encoder=enc, vae=vae, transformer=transformer, scheduler=D.FlowMatchEulerDiscreteScheduler())
    if kind == "cogvideox":
        tok, enc = _t5(torch)
        transformer = D.CogVideoXTransformer3DModel(num_attention_heads=4, attention_head_dim=8, in_channels=4, out_channels=4, time_embed_dim=2, text_embed_dim=32, num_layers=1, sample_width=2, sample_height=2, sample_frames=9, patch_size=2, temporal_compression_ratio=4, max_text_seq_length=226)
        vae = D.AutoencoderKLCogVideoX(in_channels=3, out_channels=3, down_block_types=("CogVideoXDownBlock3D",) * 4, up_block_types=("CogVideoXUpBlock3D",) * 4, block_out_channels=(8, 8, 8, 8), latent_channels=4, layers_per_block=1, norm_num_groups=2, temporal_compression_ratio=4)
        return D.CogVideoXPipeline(tokenizer=tok, text_encoder=enc, vae=vae, transformer=transformer, scheduler=D.DDIMScheduler())
    if kind == "animatediff":
        tok, enc = _clip(torch)
        unet = D.UNet2DConditionModel(block_out_channels=(32, 64), layers_per_block=2, sample_size=32, in_channels=4, out_channels=4, down_block_types=("CrossAttnDownBlock2D", "DownBlock2D"), up_block_types=("CrossAttnUpBlock2D", "UpBlock2D"), cross_attention_dim=32, norm_num_groups=2)
        vae = D.AutoencoderKL(block_out_channels=[32, 64], in_channels=3, out_channels=3, down_block_types=["DownEncoderBlock2D", "DownEncoderBlock2D"], up_block_types=["UpDecoderBlock2D", "UpDecoderBlock2D"], latent_channels=4, norm_num_groups=2)
        adapter = D.MotionAdapter(block_out_channels=(32, 64), motion_layers_per_block=2, motion_norm_num_groups=2, motion_num_attention_heads=4)
        # Same weight-loading path as the real model: state dict into a MotionAdapter.
        state = {k: v.clone() for k, v in adapter.state_dict().items()}
        adapter.load_state_dict(state)
        cls = D.AnimateDiffVideoToVideoPipeline if task == "video-to-video" else D.AnimateDiffPipeline
        pipe = cls(vae=vae, text_encoder=enc, tokenizer=tok, unet=unet, motion_adapter=adapter, scheduler=D.DDIMScheduler(beta_schedule="linear", clip_sample=False))
        pipe.scheduler = D.EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing", beta_schedule="linear")
        return pipe
    raise ValueError(kind)
