// Package captcha 生成简单的数字图形验证码(纯标准库, 无第三方依赖)。
// 一个进程内 Store 保存 id→code(带 TTL, 一次性消费), 登录前端拉取图片并回填。
package captcha

import (
	"bytes"
	"crypto/rand"
	"image"
	"image/color"
	"image/png"
	"math"
	"math/big"
	mrand "math/rand"
	"sync"
	"time"
)

const (
	codeLen = 4
	ttl     = 3 * time.Minute
	// 图片尺寸(放大后)。
	scale   = 6
	glyphW  = 5
	glyphH  = 7
	padX    = 20
	padY    = 12
	gap     = 10
	imgW    = codeLen*(glyphW*scale) + (codeLen-1)*gap + 2*padX
	imgH    = glyphH*scale + 2*padY
)

// digitGlyphs 是 0-9 的 5x7 位图字体("#"=前景)。
var digitGlyphs = [10][glyphH]string{
	{"01110", "10001", "10011", "10101", "11001", "10001", "01110"}, // 0
	{"00100", "01100", "00100", "00100", "00100", "00100", "01110"}, // 1
	{"01110", "10001", "00001", "00010", "00100", "01000", "11111"}, // 2
	{"11111", "00010", "00100", "00010", "00001", "10001", "01110"}, // 3
	{"00010", "00110", "01010", "10010", "11111", "00010", "00010"}, // 4
	{"11111", "10000", "11110", "00001", "00001", "10001", "01110"}, // 5
	{"00110", "01000", "10000", "11110", "10001", "10001", "01110"}, // 6
	{"11111", "00001", "00010", "00100", "01000", "01000", "01000"}, // 7
	{"01110", "10001", "10001", "01110", "10001", "10001", "01110"}, // 8
	{"01110", "10001", "10001", "01111", "00001", "00010", "01100"}, // 9
}

type entry struct {
	code string
	exp  time.Time
}

// Store 是进程内验证码存储(一次性、TTL)。
type Store struct {
	mu sync.Mutex
	m  map[string]entry
}

// NewStore 创建一个验证码存储。
func NewStore() *Store {
	return &Store{m: make(map[string]entry)}
}

// Generate 生成一条验证码, 返回 id 与 PNG 字节。
func (s *Store) Generate() (id string, pngBytes []byte, err error) {
	code := randomCode()
	img := render(code)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", nil, err
	}
	id = randomID()
	s.mu.Lock()
	s.purgeLocked()
	s.m[id] = entry{code: code, exp: time.Now().Add(ttl)}
	s.mu.Unlock()
	return id, buf.Bytes(), nil
}

// Verify 校验并一次性消费一条验证码(不区分大小写, 数字场景无碍)。
func (s *Store) Verify(id, code string) bool {
	if id == "" || code == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.m[id]
	if !ok {
		return false
	}
	delete(s.m, id) // 一次性: 无论对错都作废, 防暴力。
	if time.Now().After(e.exp) {
		return false
	}
	return e.code == code
}

// purgeLocked 清理过期项(调用方须持锁)。
func (s *Store) purgeLocked() {
	now := time.Now()
	for k, v := range s.m {
		if now.After(v.exp) {
			delete(s.m, k)
		}
	}
}

// render 把数字串画成带噪点、错切与波浪扭曲的 PNG 图像(防 OCR)。
func render(code string) *image.RGBA {
	bg := color.RGBA{R: 240, G: 244, B: 250, A: 255}
	img := image.NewRGBA(image.Rect(0, 0, imgW, imgH))
	for y := 0; y < imgH; y++ {
		for x := 0; x < imgW; x++ {
			img.Set(x, y, bg)
		}
	}
	// 噪点。
	for i := 0; i < imgW*imgH/16; i++ {
		img.Set(mrand.Intn(imgW), mrand.Intn(imgH), color.RGBA{
			R: uint8(mrand.Intn(200)), G: uint8(mrand.Intn(200)), B: uint8(mrand.Intn(200)), A: 100,
		})
	}
	// 直线干扰。
	for i := 0; i < 3; i++ {
		drawLine(img, mrand.Intn(imgW), mrand.Intn(imgH), mrand.Intn(imgW), mrand.Intn(imgH),
			color.RGBA{R: uint8(mrand.Intn(180)), G: uint8(mrand.Intn(180)), B: uint8(mrand.Intn(180)), A: 130})
	}
	// 数字(每位随机错切 + 垂直抖动)。
	palette := []color.RGBA{
		{R: 30, G: 90, B: 180, A: 255}, {R: 180, G: 60, B: 60, A: 255},
		{R: 40, G: 140, B: 90, A: 255}, {R: 120, G: 70, B: 160, A: 255},
	}
	for i, ch := range code {
		g := digitGlyphs[ch-'0']
		col := palette[mrand.Intn(len(palette))]
		jitterY := mrand.Intn(padY) - padY/2
		shear := (mrand.Float64() - 0.5) * 0.36 // 斜切 -0.18..0.18
		baseX := padX + i*(glyphW*scale+gap)
		for row := 0; row < glyphH; row++ {
			sx := int(shear * float64((glyphH-row)*scale))
			for c := 0; c < glyphW; c++ {
				if g[row][c] != '1' {
					continue
				}
				fillBlock(img, baseX+c*scale+sx, padY+jitterY+row*scale, scale, col)
			}
		}
	}
	// 正弦干扰曲线(穿过数字)。
	sineCurve(img, color.RGBA{
		R: uint8(mrand.Intn(170)), G: uint8(mrand.Intn(170)), B: uint8(mrand.Intn(170)), A: 150,
	})
	// 整体波浪扭曲, 破坏笔画的横平竖直。
	return warp(img, bg)
}

// warp 按正弦位移对整张图重采样, 使数字边缘产生波浪形变。
func warp(src *image.RGBA, bg color.RGBA) *image.RGBA {
	out := image.NewRGBA(src.Bounds())
	ax := 1.6 + mrand.Float64()*1.4  // 水平振幅
	ay := 1.0 + mrand.Float64()*1.0  // 垂直振幅
	px := 12.0 + mrand.Float64()*8.0 // 周期(越大越平缓)
	py := 12.0 + mrand.Float64()*8.0
	ph1 := mrand.Float64() * 2 * math.Pi
	ph2 := mrand.Float64() * 2 * math.Pi
	for y := 0; y < imgH; y++ {
		for x := 0; x < imgW; x++ {
			sx := x + int(ax*math.Sin(float64(y)/px+ph1))
			sy := y + int(ay*math.Sin(float64(x)/py+ph2))
			if sx >= 0 && sx < imgW && sy >= 0 && sy < imgH {
				out.Set(x, y, src.At(sx, sy))
			} else {
				out.Set(x, y, bg)
			}
		}
	}
	return out
}

// sineCurve 画一条穿过图像的正弦曲线(2px 粗)。
func sineCurve(img *image.RGBA, col color.RGBA) {
	amp := 4.0 + mrand.Float64()*7.0
	period := 18.0 + mrand.Float64()*26.0
	phase := mrand.Float64() * 2 * math.Pi
	mid := mrand.Intn(imgH)
	for x := 0; x < imgW; x++ {
		y := mid + int(amp*math.Sin(float64(x)/period+phase))
		for t := 0; t < 2; t++ {
			if y+t >= 0 && y+t < imgH {
				img.Set(x, y+t, col)
			}
		}
	}
}

func fillBlock(img *image.RGBA, x0, y0, size int, col color.RGBA) {
	for y := y0; y < y0+size; y++ {
		for x := x0; x < x0+size; x++ {
			if x >= 0 && x < imgW && y >= 0 && y < imgH {
				img.Set(x, y, col)
			}
		}
	}
}

func drawLine(img *image.RGBA, x0, y0, x1, y1 int, col color.RGBA) {
	dx, dy := abs(x1-x0), -abs(y1-y0)
	sx, sy := sign(x1-x0), sign(y1-y0)
	err := dx + dy
	for {
		if x0 >= 0 && x0 < imgW && y0 >= 0 && y0 < imgH {
			img.Set(x0, y0, col)
		}
		if x0 == x1 && y0 == y1 {
			break
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x0 += sx
		}
		if e2 <= dx {
			err += dx
			y0 += sy
		}
	}
}

func abs(a int) int {
	if a < 0 {
		return -a
	}
	return a
}
func sign(a int) int {
	switch {
	case a > 0:
		return 1
	case a < 0:
		return -1
	}
	return 0
}

func randomCode() string {
	b := make([]byte, codeLen)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(10))
		b[i] = byte('0' + n.Int64())
	}
	return string(b)
}

func randomID() string {
	const hex = "0123456789abcdef"
	b := make([]byte, 32)
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	for i, v := range raw {
		b[i*2] = hex[v>>4]
		b[i*2+1] = hex[v&0x0f]
	}
	return string(b)
}
